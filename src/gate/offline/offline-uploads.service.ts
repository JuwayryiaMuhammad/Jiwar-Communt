import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type GateDevice,
  type GateOfflineAction,
  type GateOfflineBatch,
  type GateOfflineBundle,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  AppException,
  appError,
  ErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { LockdownCore } from '../lockdown/lockdown-core';
import { SafetyCore } from '../safety/safety-core';
import {
  DeviceEnvelopes,
  type DeviceEnvelope,
  type OpenedEnvelope,
} from './device-envelopes';
import { GateDevicesService } from './gate-devices.service';
import { OfflineHandlers } from './offline-handlers';
import { OfflineFlags, type NewFlag } from './offline-flags.service';
import {
  parseUpload,
  quarantineBody,
  REJECTION_FLAG,
  SKEW_MS,
  whenOf,
  type FlagKind,
  type OfflineAction,
  type Rejection,
} from './offline-rules';

/** How often a device's refused uploads are told, at most. */
export const REJECTION_ALERT_MS = 15 * 60_000;
/** A quarantined batch's review's own key. */
export const BATCH_REVIEW = 'gate_offline_batch_review';
const PAGE = keysetCursor('receivedAt');

export type ActionStatus =
  'recorded' | 'duplicate' | 'rejected' | 'quarantined';

export interface ActionResult {
  clientId: string;
  seq: number;
  status: ActionStatus;
  /** Why it was rejected: its code. */
  reason: string | null;
  flags: FlagKind[];
  /** The entry it recorded. */
  entryId: string | null;
}

export interface UploadResult {
  batchId: string;
  receivedAt: Date;
  /** Every action up to this one was received, without a gap. */
  ackedThroughSeq: number;
  results: ActionResult[];
  serverTime: Date;
}

/** Why an upload was refused whole, as the audit and the alert say it. */
export type UploadRefusal = 'signature' | 'envelope' | 'payload';

export type BatchFilter = 'pending' | 'reviewed' | 'all';

/** A batch as the management reads it: codes and ids, what each action did. */
export interface BatchView {
  id: string;
  deviceId: string;
  uploadedBy: { id: string; fullName: string | null; status: string };
  receivedAt: Date;
  sentAt: Date;
  clockOffsetMs: number;
  actionCount: number;
  status: 'accepted' | 'quarantined';
  /** Quarantined actions wait for the management. */
  pendingReview: boolean;
  reviewedAt: Date | null;
  reviewedBy: { id: string; fullName: string | null; status: string } | null;
  reviewDecision: 'accepted' | 'rejected' | null;
  actions: {
    clientId: string;
    seq: number;
    type: string;
    status: 'recorded' | 'rejected' | 'quarantined';
    reason: string | null;
    deviceTime: Date;
    occurredAt: Date | null;
    entryId: string | null;
    /** What a quarantined action says it was about. */
    subject: { type: string; id: string } | null;
    direction: string | null;
  }[];
}

export const batchNotFound = () =>
  appError.notFound(
    ErrorCode.GATE_OFFLINE_BATCH_NOT_FOUND,
    'Offline batch not found',
  );

/**
 * Offline uploads (ADR 0057): what a guard device recorded without
 * network, in signed batches, recorded at sync without loss.
 *
 * 1. The envelope (DeviceEnvelopes): the device's signature over the
 *    payload as sent. A signature that does not verify, an envelope that
 *    says something else, a payload that does not parse: the whole batch
 *    is refused, audited, and the management told (once per device in 15
 *    minutes); nothing else is written.
 * 2. The batch, once per id: a retry answers what its actions recorded.
 * 3. Each action in its own transaction, in sequence: a duplicate id with
 *    the same content answers what it recorded; one whose id or sequence
 *    number another action holds is flagged and not recorded; one whose
 *    bundle or subject this compound does not know cannot have happened
 *    and is rejected, flagged; everything else is recorded at its device
 *    time (clamped, offline-rules.ts `whenOf`), with its flags.
 * 4. The batch's flags told, once (OfflineFlags.alertBatch).
 *
 * **A revoked device's upload is quarantined, never discarded:** its
 * actions are kept as sent (less anything secret), nothing is recorded,
 * one security flag goes on the batch, and the management accepts the
 * batch (each action decided as it would have been at its receipt) or
 * rejects it (each kept, rejected).
 *
 * The uploader is any active guard: what an action records is attributed
 * to its bundle's guard, shift and gate.
 *
 * Lock order per action: the uploader's account (FOR SHARE), the bundle's
 * shift (FOR SHARE, ended or not), the device (FOR UPDATE), the batch, the
 * lockdown row (FOR SHARE), the blocklist (shared), the subject's row. A
 * review takes every shift of the batch's bundles first, in id order.
 */
@Injectable()
export class OfflineUploadsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly safety: SafetyCore,
    private readonly audit: AuditService,
    private readonly envelopes: DeviceEnvelopes,
    private readonly devices: GateDevicesService,
    private readonly lockdown: LockdownCore,
    private readonly settings: TenantSettingsService,
    private readonly handlers: OfflineHandlers,
    private readonly flags: OfflineFlags,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(BATCH_REVIEW, (id) => this.get(id));
  }

  // --------------------------------------------------------------------------
  // The guard's device (`gate.operate`)
  // --------------------------------------------------------------------------

  async upload(envelope: DeviceEnvelope): Promise<UploadResult> {
    const opened = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      let o: OpenedEnvelope;
      try {
        o = await this.envelopes.open(tx, envelope, 'upload');
      } catch (e) {
        const why = refusalOf(e);
        if (why) return { refused: why, error: e as AppException };
        throw e;
      }
      // Seen, and uploading: whatever the batch turns out to hold.
      await tx.gateDevice.update({
        where: { id: o.device.id },
        data: { lastSeenAt: o.now, lastUploadAt: o.now },
      });
      const parsed = parseUpload(o.payload);
      if ('problems' in parsed)
        return {
          refused: 'payload' as const,
          error: appError.badRequest(
            ErrorCode.VALIDATION_FAILED,
            'The upload’s payload does not parse',
            {
              fields: parsed.problems.map((p): FieldError => ({
                field: `payload.${p.field}`,
                code: p.code,
              })),
            },
          ),
        };
      const payloadSha256 = createHash('sha256')
        .update(envelope.payload)
        .digest('hex');
      const status = o.device.revokedAt ? 'quarantined' : 'accepted';
      await tx.$executeRaw`
        INSERT INTO gate_offline_batches
          (id, tenant_id, device_id, uploaded_by_account_id, received_at, sent_at,
           clock_offset_ms, payload_sha256, action_count, status)
        VALUES (${parsed.batchId}::uuid, ${this.ctx.txTenantId}::uuid, ${o.device.id}::uuid,
                ${this.ctx.accountId}::uuid, ${o.now}, ${o.sentAt},
                ${Math.round(o.sentAt.getTime() - o.now.getTime())},
                ${payloadSha256}, ${parsed.actions.length}, ${status})
        ON CONFLICT DO NOTHING`;
      const batch = await tx.gateOfflineBatch.findUnique({
        where: { id: parsed.batchId },
      });
      // A batch id this device did not use: another device's.
      if (!batch || batch.deviceId !== o.device.id)
        return {
          refused: 'payload' as const,
          error: appError.badRequest(
            ErrorCode.VALIDATION_FAILED,
            'This batch id is taken',
            {
              fields: [{ field: 'payload.batchId', code: 'INVALID_VALUE' }],
            },
          ),
        };
      // Told once per batch: a device whose clock drifted from its
      // calibration (ADR 0057's two minutes).
      if (
        batch.receivedAt.getTime() === o.now.getTime() &&
        Math.abs(batch.clockOffsetMs) > SKEW_MS
      )
        await this.flags.raise(tx, [
          {
            kind: 'clock_skew',
            batchId: batch.id,
            deviceId: o.device.id,
            params: { offsetSeconds: Math.round(batch.clockOffsetMs / 1000) },
          },
        ]);
      return {
        device: o.device,
        batchId: batch.id,
        receivedAt: batch.receivedAt,
        actions: parsed.actions,
      };
    });
    if (opened.refused) {
      await this.refused(envelope.deviceId, opened.refused);
      throw opened.error;
    }
    const results: ActionResult[] = [];
    for (const a of opened.actions)
      results.push(await this.one(opened.device.id, opened.batchId, a));
    const acked = await this.tenantTx.withTenantTx(async (tx) => {
      await this.flags.alertBatch(tx, opened.batchId);
      return {
        device: await this.devices.row(tx, opened.device.id),
        now: await dbNow(tx),
      };
    });
    return {
      batchId: opened.batchId,
      receivedAt: opened.receivedAt,
      ackedThroughSeq: acked.device.ackedSeq,
      results,
      serverTime: acked.now,
    };
  }

  // --------------------------------------------------------------------------
  // The management (`gate_devices.manage`)
  // --------------------------------------------------------------------------

  /** Newest first; `pending`: holding quarantined actions to decide. */
  list(q: {
    status?: BatchFilter;
    deviceId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<BatchView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const pending = await this.pendingIds(tx);
      const status: Prisma.GateOfflineBatchWhereInput =
        q.status === 'pending'
          ? { id: { in: [...pending] } }
          : q.status === 'reviewed'
            ? { reviewedAt: { not: null } }
            : {};
      const rows = await tx.gateOfflineBatch.findMany({
        where: {
          AND: [
            status,
            q.deviceId ? { deviceId: q.deviceId } : {},
            ...(PAGE.after(q.cursor) as Prisma.GateOfflineBatchWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: BatchView[] = [];
      for (const r of page.items) items.push(await this.view(tx, r));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<BatchView> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.view(tx, await this.batch(tx, id)),
    );
  }

  /**
   * A revoked device's quarantined actions decided, all of the batch at
   * once (ADR 0057): accepted, each is decided as at its receipt — what it
   * records at its device time, its flags, or its rejection; rejected,
   * each is kept, rejected (`quarantine_rejected`). Once
   * (GATE_OFFLINE_BATCH_REVIEWED after); a batch with nothing quarantined
   * is GATE_OFFLINE_BATCH_NOT_QUARANTINED.
   */
  review(id: string, decision: 'accept' | 'reject'): Promise<BatchView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const batch = await this.batch(tx, id);
      await this.idempotency.claim(tx, { type: BATCH_REVIEW, id });
      const held = await tx.gateOfflineAction.findMany({
        where: { batchId: id, status: 'quarantined' },
        select: { bundleId: true },
      });
      if (!held.length) throw this.notPending(batch);
      // Every shift of the batch's bundles, in id order, before the device.
      const bundleIds = [
        ...new Set(
          held.map((h) => h.bundleId).filter((b): b is string => b !== null),
        ),
      ];
      const bundles = new Map(
        (
          await tx.gateOfflineBundle.findMany({
            where: { id: { in: bundleIds } },
          })
        ).map((b) => [b.id, b]),
      );
      const shifts = new Map<string, Date | null>();
      for (const shiftId of [
        ...new Set([...bundles.values()].map((b) => b.shiftId)),
      ].sort()) {
        const [s] = await tx.$queryRaw<{ ended_at: Date | null }[]>`
          SELECT ended_at FROM guard_shifts WHERE id = ${shiftId}::uuid FOR SHARE`;
        shifts.set(shiftId, s?.ended_at ?? null);
      }
      await this.devices.lock(tx, batch.deviceId);
      const device = await this.devices.row(tx, batch.deviceId);
      await tx.$queryRaw`SELECT id FROM gate_offline_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const rows = await tx.gateOfflineAction.findMany({
        where: { batchId: id, status: 'quarantined' },
        orderBy: { seq: 'asc' },
      });
      if (!rows.length) throw this.notPending(await this.batch(tx, id));
      const now = await dbNow(tx);
      await this.lockdown.lockState(tx, 'share');
      let recorded = 0;
      for (const row of rows) {
        if (decision === 'reject') {
          await tx.gateOfflineAction.update({
            where: { id: row.id },
            data: {
              status: 'rejected',
              rejectReason: 'quarantine_rejected',
              body: Prisma.DbNull,
              reviewedAt: now,
            },
          });
          continue;
        }
        const action = actionOf(row);
        const bundle = row.bundleId ? bundles.get(row.bundleId) : undefined;
        const own = bundle && bundle.deviceId === device.id ? bundle : null;
        const result = await this.decide(tx, device, id, action, {
          bundle: own,
          shiftEndedAt: own ? (shifts.get(own.shiftId) ?? null) : null,
          receivedAt: row.receivedAt,
          stored: { row, reviewedAt: now },
        });
        if (result.status === 'recorded') recorded++;
      }
      const updated = await tx.gateOfflineBatch.update({
        where: { id },
        data: {
          reviewedAt: now,
          reviewedById: this.ctx.accountId,
          reviewDecision: decision === 'accept' ? 'accepted' : 'rejected',
        },
      });
      await this.audit.record(tx, {
        action: 'gate_offline_batch.reviewed',
        targetId: id,
        metadata: {
          decision: updated.reviewDecision,
          actions: rows.length,
          recorded,
        },
      });
      await this.flags.alertBatch(tx, id);
      return this.view(tx, updated);
    });
  }

  // --------------------------------------------------------------------------

  /** One action, in a transaction of its own. */
  private one(
    deviceId: string,
    batchId: string,
    a: OfflineAction,
  ): Promise<ActionResult> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const bundle = await tx.gateOfflineBundle.findUnique({
        where: { id: a.bundleId },
      });
      const own = bundle && bundle.deviceId === deviceId ? bundle : null;
      const shift = own
        ? (
            await tx.$queryRaw<{ ended_at: Date | null }[]>`
              SELECT ended_at FROM guard_shifts
               WHERE id = ${own.shiftId}::uuid FOR SHARE`
          )[0]
        : null;
      await this.devices.lock(tx, deviceId);
      const device = await this.devices.row(tx, deviceId);
      const existing = await tx.gateOfflineAction.findUnique({
        where: { id: a.clientId },
      });
      if (existing) {
        if (
          existing.deviceId === deviceId &&
          existing.seq === a.seq &&
          existing.contentSha256 === a.contentSha256
        )
          return this.answer(tx, existing, 'duplicate');
        return this.collision(tx, device, batchId, a, 'client_id_reused');
      }
      if (
        await tx.gateOfflineAction.count({
          where: { deviceId, seq: a.seq },
        })
      )
        return this.collision(tx, device, batchId, a, 'sequence_reused');
      const receivedAt = await dbNow(tx);
      // A revoked device: kept as sent, for the management to decide.
      if (device.revokedAt) {
        const row = await tx.gateOfflineAction.create({
          data: {
            ...this.base(a, device.id, batchId, receivedAt),
            bundleId: own?.id ?? null,
            status: 'quarantined',
            body: quarantineBody(a) as Prisma.InputJsonValue,
          },
        });
        if (
          !(await tx.gateOfflineFlag.count({
            where: { batchId, kind: 'device_revoked_upload' },
          }))
        )
          await this.flags.raise(tx, [
            { kind: 'device_revoked_upload', batchId, deviceId },
          ]);
        await this.acknowledge(tx, device, a.seq);
        return this.answer(tx, row, 'quarantined');
      }
      await this.lockdown.lockState(tx, 'share');
      const result = await this.decide(tx, device, batchId, a, {
        bundle: own,
        shiftEndedAt: shift?.ended_at ?? null,
        receivedAt,
        stored: null,
      });
      await this.acknowledge(tx, device, a.seq);
      return result;
    });
  }

  /**
   * One action decided, the prefix held (the account, the bundle's shift,
   * the device, the lockdown row): rejected when its bundle or subject is
   * unknown, else recorded at its device time with its flags. Written as a
   * new row, or onto its quarantined one (`stored`, a review).
   */
  private async decide(
    tx: TenantTxClient,
    device: GateDevice,
    batchId: string,
    a: OfflineAction,
    at: {
      bundle: GateOfflineBundle | null;
      shiftEndedAt: Date | null;
      receivedAt: Date;
      stored: { row: GateOfflineAction; reviewedAt: Date } | null;
    },
  ): Promise<ActionResult> {
    const write = async (
      data: Omit<Prisma.GateOfflineActionUncheckedCreateInput, keyof Base>,
    ) =>
      at.stored
        ? tx.gateOfflineAction.update({
            where: { id: at.stored.row.id },
            data: {
              ...data,
              body: Prisma.DbNull,
              reviewedAt: at.stored.reviewedAt,
            },
          })
        : tx.gateOfflineAction.create({
            data: {
              ...this.base(a, device.id, batchId, at.receivedAt),
              ...data,
            },
          });
    const reject = async (
      reason: Rejection,
      bundleId: string | null,
      params: Record<string, string | number> = {},
    ) => {
      const row = await write({
        bundleId,
        status: 'rejected',
        rejectReason: reason,
      });
      const kind = REJECTION_FLAG[reason];
      if (kind)
        await this.flags.raise(tx, [
          {
            kind,
            batchId,
            deviceId: device.id,
            actionId: row.id,
            ...(bundleId && at.bundle
              ? { gateId: at.bundle.gateId, shiftId: at.bundle.shiftId }
              : {}),
            params: { reason, ...params },
          },
        ]);
      return this.answer(tx, row, 'rejected');
    };
    const own = at.bundle;
    if (!own) return reject('bundle_unknown', null);
    const previous = await tx.gateOfflineAction.findUnique({
      where: {
        tenantId_deviceId_seq: {
          tenantId: this.ctx.txTenantId,
          deviceId: device.id,
          seq: a.seq - 1,
        },
      },
      select: { deviceTime: true },
    });
    const when = whenOf({
      deviceTime: a.deviceTime,
      previousDeviceTime: previous?.deviceTime ?? null,
      bundle: own,
      receivedAt: at.receivedAt,
      shiftEndedAt: at.shiftEndedAt,
    });
    const gate = await tx.gate.findUniqueOrThrow({
      where: { id: own.gateId },
      select: { name: true },
    });
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    const outcome = await this.handlers.handle(tx, a, {
      occurredAt: when.occurredAt,
      gateId: own.gateId,
      gateName: gate.name,
      shiftId: own.shiftId,
      guardId: own.guardAccountId,
      timezone,
      actionId: a.clientId,
    });
    if ('rejection' in outcome)
      return reject(outcome.rejection, own.id, outcome.params);
    const row = await write({
      bundleId: own.id,
      occurredAt: when.occurredAt,
      status: 'recorded',
      guardAccountId: own.guardAccountId,
      shiftId: own.shiftId,
      gateId: own.gateId,
      entryId: outcome.recorded.entryId ?? null,
      serviceVehicleVisitId: outcome.recorded.serviceVehicleVisitId ?? null,
      materialEntryId: outcome.recorded.materialEntryId ?? null,
      patrolScanId: outcome.recorded.patrolScanId ?? null,
      childPickupId: outcome.recorded.childPickupId ?? null,
    });
    const where = { gateId: own.gateId, shiftId: own.shiftId };
    await this.flags.raise(tx, [
      ...when.flags.map((kind): NewFlag => ({
        kind,
        batchId,
        deviceId: device.id,
        actionId: row.id,
        ...where,
        params:
          kind === 'clock_skew' && when.skewMs !== null
            ? { skewSeconds: Math.round(when.skewMs / 1000) }
            : {},
      })),
      ...outcome.flags.map((f): NewFlag => ({
        ...f,
        batchId,
        deviceId: device.id,
        actionId: row.id,
      })),
    ]);
    return this.answer(tx, row, 'recorded');
  }

  /** What every action row holds of the action itself. */
  private base(
    a: OfflineAction,
    deviceId: string,
    batchId: string,
    receivedAt: Date,
  ): Base {
    return {
      id: a.clientId,
      tenantId: this.ctx.txTenantId,
      deviceId,
      batchId,
      seq: a.seq,
      type: a.type,
      contentSha256: a.contentSha256,
      deviceTime: a.deviceTime,
      receivedAt,
    };
  }

  /**
   * An action whose id or sequence number another one holds: not recorded
   * (the other one is), flagged on the batch.
   */
  private async collision(
    tx: TenantTxClient,
    device: GateDevice,
    batchId: string,
    a: OfflineAction,
    reason: 'client_id_reused' | 'sequence_reused',
  ): Promise<ActionResult> {
    await this.flags.raise(tx, [
      {
        kind: 'action_rejected',
        batchId,
        deviceId: device.id,
        params: { reason, seq: a.seq },
      },
    ]);
    return {
      clientId: a.clientId,
      seq: a.seq,
      status: 'rejected',
      reason,
      flags: ['action_rejected'],
      entryId: null,
    };
  }

  /**
   * The device's sequence: the highest received, and the last received
   * without a gap, walked forward over what arrived out of order.
   */
  private async acknowledge(
    tx: TenantTxClient,
    device: GateDevice,
    seq: number,
  ): Promise<void> {
    let acked = device.ackedSeq;
    if (seq === acked + 1) {
      acked = seq;
      const after = await tx.gateOfflineAction.findMany({
        where: { deviceId: device.id, seq: { gt: acked } },
        select: { seq: true },
        orderBy: { seq: 'asc' },
      });
      for (const n of after) {
        if (n.seq !== acked + 1) break;
        acked = n.seq;
      }
    }
    await tx.gateDevice.update({
      where: { id: device.id },
      data: { ackedSeq: acked, maxSeq: Math.max(device.maxSeq, seq) },
    });
  }

  private async answer(
    tx: TenantTxClient,
    row: GateOfflineAction,
    status: ActionStatus,
  ): Promise<ActionResult> {
    const flags = await tx.gateOfflineFlag.findMany({
      where: { actionId: row.id },
      select: { kind: true },
      orderBy: { kind: 'asc' },
    });
    return {
      clientId: row.id,
      seq: row.seq,
      status:
        status === 'duplicate'
          ? status
          : (row.status as 'recorded' | 'rejected' | 'quarantined'),
      reason: row.rejectReason,
      flags: flags.map((f) => f.kind as FlagKind),
      entryId: row.entryId,
    };
  }

  private async batch(
    tx: TenantTxClient,
    id: string,
  ): Promise<GateOfflineBatch> {
    const row = await tx.gateOfflineBatch.findUnique({ where: { id } });
    if (!row) throw batchNotFound();
    return row;
  }

  private notPending(batch: GateOfflineBatch) {
    return batch.reviewedAt
      ? appError.conflict(
          ErrorCode.GATE_OFFLINE_BATCH_REVIEWED,
          'This batch was reviewed already',
        )
      : appError.conflict(
          ErrorCode.GATE_OFFLINE_BATCH_NOT_QUARANTINED,
          'Nothing of this batch waits for a decision',
        );
  }

  /** The batches holding quarantined actions. */
  private async pendingIds(tx: TenantTxClient): Promise<Set<string>> {
    const rows = await tx.gateOfflineAction.findMany({
      where: { status: 'quarantined' },
      select: { batchId: true },
      distinct: ['batchId'],
    });
    return new Set(rows.map((r) => r.batchId));
  }

  private async view(
    tx: TenantTxClient,
    b: GateOfflineBatch,
  ): Promise<BatchView> {
    const actions = await tx.gateOfflineAction.findMany({
      where: { batchId: b.id },
      orderBy: { seq: 'asc' },
    });
    const people = new Map(
      (
        await tx.account.findMany({
          where: {
            id: {
              in: [b.uploadedById, ...(b.reviewedById ? [b.reviewedById] : [])],
            },
          },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, { ...a, status: String(a.status) }]),
    );
    const ref = (id: string) =>
      people.get(id) ?? { id, fullName: null, status: 'erased' };
    return {
      id: b.id,
      deviceId: b.deviceId,
      uploadedBy: ref(b.uploadedById),
      receivedAt: b.receivedAt,
      sentAt: b.sentAt,
      clockOffsetMs: b.clockOffsetMs,
      actionCount: b.actionCount,
      status: b.status as 'accepted' | 'quarantined',
      pendingReview: actions.some((a) => a.status === 'quarantined'),
      reviewedAt: b.reviewedAt,
      reviewedBy: b.reviewedById ? ref(b.reviewedById) : null,
      reviewDecision: b.reviewDecision as 'accepted' | 'rejected' | null,
      actions: actions.map((a) => {
        const body = (a.body ?? null) as Record<string, unknown> | null;
        return {
          clientId: a.id,
          seq: a.seq,
          type: a.type,
          status: a.status as 'recorded' | 'rejected' | 'quarantined',
          reason: a.rejectReason,
          deviceTime: a.deviceTime,
          occurredAt: a.occurredAt,
          entryId: a.entryId,
          subject:
            body &&
            typeof body.subjectType === 'string' &&
            typeof body.subjectId === 'string'
              ? { type: body.subjectType, id: body.subjectId }
              : null,
          direction:
            body && typeof body.direction === 'string' ? body.direction : null,
        };
      }),
    };
  }

  /**
   * A whole upload refused: audited, and the management told, once per
   * device in REJECTION_ALERT_MS. Its own transaction, which commits
   * before the refusal goes out.
   */
  private async refused(deviceId: string, why: UploadRefusal): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      const exists = await tx.gateDevice.count({ where: { id: deviceId } });
      if (!exists) return;
      await this.devices.lock(tx, deviceId);
      const device = await this.devices.row(tx, deviceId);
      const now = await dbNow(tx);
      await this.audit.record(tx, {
        action: 'gate_offline.upload_rejected',
        targetId: deviceId,
        metadata: { reason: why },
      });
      if (
        device.rejectionAlertedAt &&
        now.getTime() - device.rejectionAlertedAt.getTime() < REJECTION_ALERT_MS
      )
        return;
      await this.safety.notify(
        tx,
        await this.safety.holding(tx, 'gate_devices.manage'),
        'gate_device.upload_rejected',
        deviceId,
        { reason: why },
      );
      await tx.gateDevice.update({
        where: { id: deviceId },
        data: { rejectionAlertedAt: now },
      });
    });
  }
}

/** What every action row holds of the action itself. */
type Base = Pick<
  GateOfflineAction,
  | 'id'
  | 'tenantId'
  | 'deviceId'
  | 'batchId'
  | 'seq'
  | 'type'
  | 'contentSha256'
  | 'deviceTime'
  | 'receivedAt'
>;

/** A quarantined row's action, parsed again from what it kept. */
function actionOf(row: GateOfflineAction): OfflineAction {
  const parsed = parseUpload(
    { batchId: row.batchId, actions: [row.body as Record<string, unknown>] },
    { fromQuarantine: true },
  );
  // It parsed when it arrived, and the parser is the same.
  if ('problems' in parsed)
    throw new Error(`A quarantined action no longer parses: ${row.id}`);
  return parsed.actions[0];
}

/** Whether an error opening the envelope is the device's: audited, told. */
function refusalOf(e: unknown): UploadRefusal | null {
  if (!(e instanceof AppException)) return null;
  const code = e.code as string;
  if (code === ErrorCode.GATE_DEVICE_SIGNATURE_INVALID) return 'signature';
  if (code === ErrorCode.GATE_DEVICE_ENVELOPE_INVALID) return 'envelope';
  return null;
}
