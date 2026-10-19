import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type GateDevice } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { devicePublicKey, enrolMessage, signedBy } from './device-envelope';

/** Live devices a compound may have at once (ADR 0057). */
export const DEVICE_LIMIT = 50;
export const DEVICE_LABEL_MAX = 40;
const PAGE = keysetCursor('enrolledAt');
/** A revocation's own key: a retried revoke replays, another one conflicts. */
export const DEVICE_REVOCATION = 'gate_device_revocation';

export interface NewDevice {
  /** The device's own UUID: the same id with the same key again replays. */
  id: string;
  publicKey: string;
  label?: string | null;
  /** The enrolment message signed with the key it registers. */
  proof: string;
}

export type DeviceStatus = 'active' | 'revoked';
export type DeviceFilter = DeviceStatus | 'all';

/** What the guard's device learns of itself. */
export interface GuardDeviceView {
  id: string;
  status: DeviceStatus;
  enrolledAt: Date;
  /** The database's clock: the device calibrates its own against it. */
  serverTime: Date;
}

interface AccountRef {
  id: string;
  fullName: string | null;
  status: string;
}

/** What the management reads of a device. */
export interface StaffDeviceView {
  id: string;
  label: string | null;
  status: DeviceStatus;
  enrolledBy: AccountRef;
  enrolledAt: Date;
  revokedAt: Date | null;
  revokedBy: AccountRef | null;
  revokeReasonCode: string | null;
  /** Its last bundle's number (0: none yet) and when. */
  bundleVersion: number;
  lastBundleAt: Date | null;
}

export const deviceNotFound = () =>
  appError.notFound(ErrorCode.GATE_DEVICE_NOT_FOUND, 'Device not found');

const signatureInvalid = () =>
  appError.unprocessable(
    ErrorCode.GATE_DEVICE_SIGNATURE_INVALID,
    'The device’s signature does not verify',
  );

/**
 * Guard devices (ADR 0057): the phones that keep the gate working offline.
 *
 * - A guard enrols one with its Ed25519 public key and a proof that it
 *   holds the private key. The device is the compound's: any guard may use
 *   it. The `gate_devices.manage` holders are told, and revoke one they do
 *   not recognise.
 * - At most `DEVICE_LIMIT` live devices per compound, counted under the
 *   compound's enrolment lock.
 * - Revoked once, with a code. A revoked device downloads no bundle; what
 *   it uploads is quarantined.
 *
 * Lock order: the caller's account (FOR SHARE), then the enrolment lock or
 * the device (FOR UPDATE). Nothing takes an account after a device.
 */
@Injectable()
export class GateDevicesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly safety: SafetyCore,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(DEVICE_REVOCATION, (id) => this.get(id));
  }

  // --------------------------------------------------------------------------
  // The guard (`gate.operate`)
  // --------------------------------------------------------------------------

  /**
   * Enrols the device, or answers the same for the same id and key (a
   * retry). Another key under the id is GATE_DEVICE_EXISTS; the key under
   * another id is the same phone again (DUPLICATE_RESOURCE, publicKey).
   */
  async enrol(input: NewDevice): Promise<GuardDeviceView> {
    if (!devicePublicKey(input.publicKey))
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Not an Ed25519 public key',
        {
          fields: [{ field: 'publicKey', code: FieldErrorCode.INVALID_FORMAT }],
        },
      );
    const label = input.label?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      if (
        !signedBy(
          input.publicKey,
          enrolMessage(tenantId, input.id, input.publicKey),
          input.proof,
        )
      )
        throw signatureInvalid();
      await this.safety.lockSelf(tx);
      // One enrolment at a time per compound: the live count holds.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`gate-devices:${tenantId}`}))`;
      const now = await dbNow(tx);
      const same = await tx.gateDevice.findUnique({ where: { id: input.id } });
      if (same) {
        if (same.publicKey !== input.publicKey)
          throw appError.conflict(
            ErrorCode.GATE_DEVICE_EXISTS,
            'This device is enrolled with another key',
          );
        return this.guardView(same, now);
      }
      if (await tx.gateDevice.count({ where: { publicKey: input.publicKey } }))
        throw appError.conflict(
          ErrorCode.DUPLICATE_RESOURCE,
          'This key is enrolled already',
          {
            fields: [
              { field: 'publicKey', code: FieldErrorCode.DUPLICATE_VALUE },
            ],
          },
        );
      if (
        (await tx.gateDevice.count({ where: { revokedAt: null } })) >=
        DEVICE_LIMIT
      )
        throw appError.conflict(
          ErrorCode.GATE_DEVICE_LIMIT_REACHED,
          'The compound has as many live devices as it may',
          { params: { max: DEVICE_LIMIT } },
        );
      const row = await tx.gateDevice.create({
        data: {
          id: input.id,
          tenantId,
          publicKey: input.publicKey,
          label,
          enrolledById: this.ctx.accountId,
          enrolledAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'gate_device.enrolled',
        targetId: row.id,
        metadata: { labelled: label !== null },
      });
      await this.safety.notify(
        tx,
        await this.safety.holding(tx, 'gate_devices.manage'),
        'gate_device.enrolled',
        row.id,
        {},
        this.ctx.accountId,
      );
      return this.guardView(row, now);
    });
  }

  // --------------------------------------------------------------------------
  // The management (`gate_devices.manage`)
  // --------------------------------------------------------------------------

  /** Newest first. */
  list(q: {
    status?: DeviceFilter;
    cursor?: string;
    limit?: number;
  }): Promise<Page<StaffDeviceView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const where: Prisma.GateDeviceWhereInput =
        q.status === 'active'
          ? { revokedAt: null }
          : q.status === 'revoked'
            ? { revokedAt: { not: null } }
            : {};
      const rows = await tx.gateDevice.findMany({
        where: {
          AND: [
            where,
            ...(PAGE.after(q.cursor) as Prisma.GateDeviceWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.staffViews(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<StaffDeviceView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const [view] = await this.staffViews(tx, [await this.row(tx, id)]);
      return view;
    });
  }

  /** Revoked once, by the database's clock, under the device's lock. */
  async revoke(id: string, reasonCode: string): Promise<StaffDeviceView> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.gateDeviceRevoke,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await this.row(tx, id);
      await this.idempotency.claim(tx, { type: DEVICE_REVOCATION, id });
      await this.lock(tx, id);
      const row = await this.row(tx, id);
      if (row.revokedAt)
        throw appError.conflict(
          ErrorCode.GATE_DEVICE_ALREADY_REVOKED,
          'This device was revoked already',
        );
      const updated = await tx.gateDevice.update({
        where: { id },
        data: {
          revokedAt: await dbNow(tx),
          revokedById: this.ctx.accountId,
          revokeReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'gate_device.revoked',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      const [view] = await this.staffViews(tx, [updated]);
      return view;
    });
  }

  // --------------------------------------------------------------------------
  // Shared with the bundles and the uploads
  // --------------------------------------------------------------------------

  /** The device's row lock: after the caller's account and shift. */
  async lock(tx: TenantTxClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM gate_devices WHERE id = ${id}::uuid FOR UPDATE`;
  }

  async row(tx: TenantTxClient, id: string): Promise<GateDevice> {
    const row = await tx.gateDevice.findUnique({ where: { id } });
    if (!row) throw deviceNotFound();
    return row;
  }

  // --------------------------------------------------------------------------

  private guardView(r: GateDevice, now: Date): GuardDeviceView {
    return {
      id: r.id,
      status: r.revokedAt ? 'revoked' : 'active',
      enrolledAt: r.enrolledAt,
      serverTime: now,
    };
  }

  private async staffViews(
    tx: TenantTxClient,
    rows: readonly GateDevice[],
  ): Promise<StaffDeviceView[]> {
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.enrolledById);
      if (r.revokedById) ids.add(r.revokedById);
    }
    // Accounts are core's: read directly, never through the community port.
    const people = new Map(
      (
        await tx.account.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, { ...a, status: String(a.status) }]),
    );
    const ref = (id: string): AccountRef =>
      people.get(id) ?? { id, fullName: null, status: 'erased' };
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      status: r.revokedAt ? 'revoked' : 'active',
      enrolledBy: ref(r.enrolledById),
      enrolledAt: r.enrolledAt,
      revokedAt: r.revokedAt,
      revokedBy: r.revokedById ? ref(r.revokedById) : null,
      revokeReasonCode: r.revokeReason,
      bundleVersion: r.bundleVersion,
      lastBundleAt: r.lastBundleAt,
    }));
  }
}
