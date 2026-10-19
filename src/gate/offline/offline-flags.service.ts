import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type GateOfflineFlag } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { FLAG_CLASS, type FlagClass, type FlagKind } from './offline-rules';

const PAGE = keysetCursor('createdAt');
/** A review's own key: a retried review replays, another one conflicts. */
export const FLAG_REVIEW = 'gate_offline_flag_review';

/** A flag to raise: codes and numbers only. */
export interface NewFlag {
  kind: FlagKind;
  batchId: string;
  deviceId: string;
  actionId?: string | null;
  subject?: { type: string; id: string } | null;
  gateId?: string | null;
  shiftId?: string | null;
  params?: Record<string, string | number | boolean>;
}

export type FlagStatus = 'open' | 'reviewed' | 'cleared';

export interface FlagView {
  id: string;
  kind: FlagKind;
  class: FlagClass;
  status: FlagStatus;
  batchId: string;
  actionId: string | null;
  deviceId: string;
  subject: { type: string; id: string } | null;
  gateId: string | null;
  shiftId: string | null;
  params: Record<string, unknown>;
  createdAt: Date;
  /** When the action it is about happened (by its device), if any. */
  occurredAt: Date | null;
  clearedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: { id: string; fullName: string | null; status: string } | null;
  reviewCode: string | null;
}

export const flagNotFound = () =>
  appError.notFound(
    ErrorCode.GATE_OFFLINE_FLAG_NOT_FOUND,
    'Offline flag not found',
  );

const statusOf = (f: GateOfflineFlag): FlagStatus =>
  f.reviewedAt ? 'reviewed' : f.clearedAt ? 'cleared' : 'open';

/**
 * Offline flags (ADR 0057): what the server knew at sync that the device
 * did not, kept with codes and numbers only.
 *
 * - Raised in the action's transaction, each with its class
 *   (offline-rules.ts FLAG_CLASS).
 * - Told once per batch (`alertBatch`): a critical notice for the
 *   security ones, a normal one for the management's, nobody for the
 *   rest; the flags told carry `alerted_at`, so nothing is told twice and
 *   the sync-health sweep tells what a crash left untold.
 * - An exit without its entry is cleared when that entry arrives
 *   (`reconcile`).
 * - Reviewed once by `gate_devices.manage`, with a code.
 */
@Injectable()
export class OfflineFlags implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly safety: SafetyCore,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(FLAG_REVIEW, (id) => this.get(id));
  }

  async raise(tx: TenantTxClient, flags: readonly NewFlag[]): Promise<void> {
    if (!flags.length) return;
    const now = await dbNow(tx);
    await tx.gateOfflineFlag.createMany({
      data: flags.map((f) => ({
        id: newId(),
        tenantId: this.ctx.txTenantId,
        batchId: f.batchId,
        actionId: f.actionId ?? null,
        deviceId: f.deviceId,
        kind: f.kind,
        class: FLAG_CLASS[f.kind],
        subjectType: f.subject?.type ?? null,
        subjectId: f.subject?.id ?? null,
        gateId: f.gateId ?? null,
        shiftId: f.shiftId ?? null,
        params: f.params ?? {},
        createdAt: now,
      })),
    });
  }

  /**
   * An `in` of the subject at `at` arrived: the open exits-without-entry
   * of it that happened after it are reconciled.
   */
  async reconcile(
    tx: TenantTxClient,
    subject: { type: string; id: string },
    at: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE gate_offline_flags f
         SET cleared_at = ${await dbNow(tx)}, cleared_reason = 'reconciled'
        FROM gate_offline_actions a
       WHERE f.kind = 'exit_without_entry' AND f.cleared_at IS NULL
         AND f.subject_type = ${subject.type} AND f.subject_id = ${subject.id}::uuid
         AND a.id = f.action_id AND a.occurred_at >= ${at}`;
  }

  /**
   * Tells what the batch's untold flags say, once: the security ones
   * critically, the management's not, both to `gate_devices.manage`; an
   * entry during a lockdown also to the guards on shift at its gate.
   * Takes the flags FOR UPDATE SKIP LOCKED: another teller holding them
   * tells them. Returns how many were told.
   */
  async alertBatch(tx: TenantTxClient, batchId: string): Promise<number> {
    const untold = await tx.$queryRaw<
      { id: string; kind: FlagKind; class: FlagClass; gate_id: string | null }[]
    >`
      SELECT id, kind, class, gate_id FROM gate_offline_flags
       WHERE batch_id = ${batchId}::uuid AND alerted_at IS NULL AND class <> 'info'
         FOR UPDATE SKIP LOCKED`;
    if (!untold.length) return 0;
    const keepers = await this.safety.holding(tx, 'gate_devices.manage');
    const security = untold.filter((f) => f.class === 'security').length;
    const manager = untold.length - security;
    if (security)
      await this.safety.notify(
        tx,
        keepers,
        'gate_offline.security_conflict',
        batchId,
        { flags: security },
      );
    if (manager)
      await this.safety.notify(tx, keepers, 'gate_offline.conflicts', batchId, {
        flags: manager,
      });
    for (const gateId of new Set(
      untold
        .filter((f) => f.kind === 'lockdown_entered' && f.gate_id)
        .map((f) => f.gate_id!),
    ))
      await this.safety.notify(
        tx,
        await this.safety.guardsOnShift(tx, gateId),
        'gate_offline.lockdown_entered',
        gateId,
      );
    await tx.gateOfflineFlag.updateMany({
      where: { id: { in: untold.map((f) => f.id) } },
      data: { alertedAt: await dbNow(tx) },
    });
    return untold.length;
  }

  // --------------------------------------------------------------------------
  // The management (`gate_devices.manage`)
  // --------------------------------------------------------------------------

  /** Newest first, by status, class or device. */
  list(q: {
    status?: FlagStatus | 'all';
    class?: FlagClass;
    deviceId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<FlagView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const status: Prisma.GateOfflineFlagWhereInput =
        q.status === 'open'
          ? { reviewedAt: null, clearedAt: null }
          : q.status === 'reviewed'
            ? { reviewedAt: { not: null } }
            : q.status === 'cleared'
              ? { reviewedAt: null, clearedAt: { not: null } }
              : {};
      const rows = await tx.gateOfflineFlag.findMany({
        where: {
          AND: [
            status,
            q.class ? { class: q.class } : {},
            q.deviceId ? { deviceId: q.deviceId } : {},
            ...(PAGE.after(q.cursor) as Prisma.GateOfflineFlagWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.views(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<FlagView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const [view] = await this.views(tx, [await this.row(tx, id)]);
      return view;
    });
  }

  /** Once, with a code, under the flag's lock. */
  review(id: string, reviewCode: string): Promise<FlagView> {
    const code = requireReasonCodeOnly(
      reviewCode,
      REASON_CODES.offlineFlagReview,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await this.row(tx, id);
      await this.idempotency.claim(tx, { type: FLAG_REVIEW, id });
      await tx.$queryRaw`SELECT id FROM gate_offline_flags WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await this.row(tx, id);
      if (row.reviewedAt)
        throw appError.conflict(
          ErrorCode.GATE_OFFLINE_FLAG_REVIEWED,
          'This flag was reviewed already',
        );
      const updated = await tx.gateOfflineFlag.update({
        where: { id },
        data: {
          reviewedAt: await dbNow(tx),
          reviewedById: this.ctx.accountId,
          reviewCode: code,
        },
      });
      await this.audit.record(tx, {
        action: 'gate_offline_flag.reviewed',
        targetId: id,
        metadata: { kind: row.kind, reviewCode: code },
      });
      const [view] = await this.views(tx, [updated]);
      return view;
    });
  }

  // --------------------------------------------------------------------------

  private async row(tx: TenantTxClient, id: string): Promise<GateOfflineFlag> {
    const row = await tx.gateOfflineFlag.findUnique({ where: { id } });
    if (!row) throw flagNotFound();
    return row;
  }

  private async views(
    tx: TenantTxClient,
    rows: readonly GateOfflineFlag[],
  ): Promise<FlagView[]> {
    const actionIds = rows
      .map((r) => r.actionId)
      .filter((a): a is string => a !== null);
    const when = new Map(
      (
        await tx.gateOfflineAction.findMany({
          where: { id: { in: actionIds } },
          select: { id: true, occurredAt: true, deviceTime: true },
        })
      ).map((a) => [a.id, a.occurredAt ?? a.deviceTime]),
    );
    const reviewers = new Map(
      (
        await tx.account.findMany({
          where: {
            id: {
              in: rows
                .map((r) => r.reviewedById)
                .filter((a): a is string => a !== null),
            },
          },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, { ...a, status: String(a.status) }]),
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as FlagKind,
      class: r.class as FlagClass,
      status: statusOf(r),
      batchId: r.batchId,
      actionId: r.actionId,
      deviceId: r.deviceId,
      subject:
        r.subjectType && r.subjectId
          ? { type: r.subjectType, id: r.subjectId }
          : null,
      gateId: r.gateId,
      shiftId: r.shiftId,
      params: r.params as Record<string, unknown>,
      createdAt: r.createdAt,
      occurredAt: r.actionId ? (when.get(r.actionId) ?? null) : null,
      clearedAt: r.clearedAt,
      reviewedAt: r.reviewedAt,
      reviewedBy: r.reviewedById
        ? (reviewers.get(r.reviewedById) ?? {
            id: r.reviewedById,
            fullName: null,
            status: 'erased',
          })
        : null,
      reviewCode: r.reviewCode,
    }));
  }
}
