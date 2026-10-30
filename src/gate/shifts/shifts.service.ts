import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { ShiftView } from './views/shift.views';

/** A zone of the compound: one of its places (ADR 0047, 0050). */
export interface ShiftZone {
  id: string;
  key: string | null;
  nameEn: string;
  nameAr: string;
}

export interface ShiftRecord {
  id: string;
  gateId: string | null;
  gateName: string | null;
  zone: ShiftZone | null;
  startedAt: Date;
  endedAt: Date | null;
  /** The roster slot it filled (ADR 0050), if any. */
  slot: { startsAt: Date; endsAt: Date; lateMinutes: number | null } | null;
  /** While open: handovers waiting at its post, of the last day (ADR 0050). */
  pendingHandovers: number;
}

/** The caller's open shift at a gate: where and under which shift an action happens. */
export interface OpenShift {
  id: string;
  gateId: string;
  gateName: string;
}

/** An open shift, at a gate or in a zone (ADR 0050). */
export interface DutyShift {
  id: string;
  guardAccountId: string;
  gateId: string | null;
  placeId: string | null;
  startedAt: Date;
}

/** Where a shift is worked: a gate or a zone, exactly one. */
export type ShiftPost =
  { gateId: string; placeId: null } | { gateId: null; placeId: string };

export const SHIFT_RESOURCE = 'guard_shift';
/** What the next guard is shown: handovers of the last day (ADR 0050). */
export const PENDING_HANDOVER_MS = 24 * 3_600_000;

/** What a start hook is told: the shift that just opened. */
export interface StartedShift {
  id: string;
  gateId: string | null;
  placeId: string | null;
  guardAccountId: string;
  startedAt: Date;
}

/** Runs in the start's transaction, after the shift row exists. */
export type ShiftStartHandler = (
  tx: TenantTxClient,
  shift: StartedShift,
) => Promise<void>;

/** What the guard hands over when they end their shift (ADR 0050). */
export interface ShiftEndInput {
  /** The checklist items ticked. */
  checklist?: string[];
  notes?: string;
}

/** What an end hook is told: the shift that just ended, and why. */
export interface EndedShift extends StartedShift {
  endedAt: Date;
  reason: string;
  /** The guard's handover: present when the guard ended it (`guard`). */
  handover: ShiftEndInput | null;
}

/** Runs in the end's transaction, after the shift row is closed. */
export type ShiftEndHandler = (
  tx: TenantTxClient,
  shift: EndedShift,
) => Promise<void>;

const noOpenShift = () =>
  appError.forbidden(
    ErrorCode.NO_OPEN_SHIFT,
    'Start a shift at a gate before acting at the gate',
  );

const notAtGate = () =>
  appError.forbidden(
    ErrorCode.SHIFT_NOT_AT_GATE,
    'The open shift is in a zone, not at a gate',
  );

const DUTY_SELECT = {
  id: true,
  guardAccountId: true,
  gateId: true,
  placeId: true,
  startedAt: true,
} as const;

/**
 * Guard shifts (ADR 0028, 0050). A guard works a post — a gate, or a zone
 * (one of the compound's places) — only inside an open shift; one open
 * shift per guard (a partial unique index backs the check). The gate's
 * actions need a shift at a gate. A guard who leaves the compound's service
 * (deactivated, frozen, erased) has their shift ended in the same
 * transaction, as does a gate deactivated or a zone retired.
 */
@Injectable()
export class ShiftsService implements OnModuleInit {
  private readonly started: ShiftStartHandler[] = [];
  private readonly ended: ShiftEndHandler[] = [];

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    // A replay answers what the route answered: the view, not the record.
    this.idempotency.renderer(SHIFT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        ShiftView.from(await this.record(tx, id)),
      ),
    );
    const endOwn = async (
      tx: TenantTxClient,
      account: { id: string },
      reason: string,
    ) => {
      const open = await this.onDuty(tx, account.id);
      if (open) await this.close(tx, open.id, reason);
    };
    this.lifecycle.onDeactivated(async (tx, account) => {
      await endOwn(tx, account, 'account_deactivated');
      return [];
    });
    this.lifecycle.onFrozen((tx, account) =>
      endOwn(tx, account, 'account_frozen'),
    );
    this.lifecycle.onErasing(async (tx, account) => {
      await endOwn(tx, account, 'account_erased');
      return [];
    });
  }

  /**
   * A domain that has something to tell a guard who starts a shift registers
   * here (the parcels do, ADR 0035; the roster links the slot, ADR 0050).
   * Handlers run in the start's transaction.
   */
  onStarted(handler: ShiftStartHandler): void {
    this.started.push(handler);
  }

  /**
   * Runs for every end — the guard's, and the system's (a gate deactivated,
   * a zone retired, the guard leaving) — in its transaction, after the row
   * is closed (ADR 0050).
   */
  onEnded(handler: ShiftEndHandler): void {
    this.ended.push(handler);
  }

  /**
   * The caller's open shift at a gate, or 403: NO_OPEN_SHIFT without one,
   * SHIFT_NOT_AT_GATE for a zone shift.
   */
  async requireOpen(tx: TenantTxClient): Promise<OpenShift> {
    const shift = await tx.guardShift.findFirst({
      where: { guardAccountId: this.ctx.accountId, endedAt: null },
      include: { gate: { select: { name: true } } },
    });
    if (!shift) throw noOpenShift();
    if (!shift.gateId || !shift.gate) throw notAtGate();
    return { id: shift.id, gateId: shift.gateId, gateName: shift.gate.name };
  }

  /**
   * As `requireOpen`, with the shift's row FOR SHARE for the rest of the
   * transaction (ADR 0056's lock order: the account, then the shift): an
   * end, which locks it for update, waits for this write, or ended it
   * first and the guard is refused.
   */
  async requireOpenLocked(tx: TenantTxClient): Promise<OpenShift> {
    const shift = await this.requireOpen(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_shifts
       WHERE id = ${shift.id}::uuid AND ended_at IS NULL FOR SHARE`;
    if (!rows.length) throw noOpenShift();
    return shift;
  }

  /** The caller's open shift wherever it is, or 403 NO_OPEN_SHIFT. */
  async requireOnDuty(tx: TenantTxClient): Promise<DutyShift> {
    const shift = await this.onDuty(tx, this.ctx.accountId);
    if (!shift) throw noOpenShift();
    return shift;
  }

  /**
   * As `requireOnDuty`, a gate's shift or a zone's, with its row FOR SHARE
   * for the rest of the transaction (ADR 0056's lock order: the account,
   * then the shift): an end waits for this write, or ended it first and
   * the guard is refused.
   */
  async requireOnDutyLocked(tx: TenantTxClient): Promise<DutyShift> {
    const shift = await this.requireOnDuty(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_shifts
       WHERE id = ${shift.id}::uuid AND ended_at IS NULL FOR SHARE`;
    if (!rows.length) throw noOpenShift();
    return shift;
  }

  /**
   * The caller's open shift, if any, with its row FOR SHARE (ADR 0056's
   * lock order), for a write a guard may also make off shift: an end in
   * flight is waited for, and one that came first leaves them off shift.
   */
  async onDutyLocked(tx: TenantTxClient): Promise<DutyShift | null> {
    const shift = await this.onDuty(tx, this.ctx.accountId);
    if (!shift) return null;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_shifts
       WHERE id = ${shift.id}::uuid AND ended_at IS NULL FOR SHARE`;
    return rows.length ? shift : null;
  }

  /**
   * A zone's open shifts, locked as their end locks them, before the zone
   * itself is retired (ADR 0056's lock order: the shift, then the place).
   * A guard write in flight holds its shift FOR SHARE: the retirement
   * waits for it here, never while holding the place it may read.
   */
  async lockOpenInZone(tx: TenantTxClient, placeId: string): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM guard_shifts
       WHERE place_id = ${placeId}::uuid AND ended_at IS NULL
       ORDER BY id FOR NO KEY UPDATE`;
  }

  /** A guard's open shift, if any. */
  onDuty(
    tx: TenantTxClient,
    guardAccountId: string,
  ): Promise<DutyShift | null> {
    return tx.guardShift.findFirst({
      where: { guardAccountId, endedAt: null },
      select: DUTY_SELECT,
    });
  }

  current(): Promise<ShiftRecord> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.record(tx, (await this.requireOnDuty(tx)).id),
    );
  }

  /**
   * At a gate in service, or in a zone in service (`zoneId`): exactly one.
   * The post is read FOR SHARE, so deactivating it waits for the start and
   * then ends the shift with the others. `Idempotency-Key`: a retry replays
   * the same shift.
   */
  start(input: { gateId?: string; zoneId?: string }): Promise<ShiftRecord> {
    const post = shiftPostOf(input);
    const guardAccountId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      if (post.gateId) {
        const rows = await tx.$queryRaw<{ status: string }[]>`
          SELECT status::text AS status FROM gates
           WHERE id = ${post.gateId}::uuid FOR SHARE`;
        if (rows[0]?.status !== 'active')
          throw appError.notFound(ErrorCode.GATE_NOT_FOUND, 'Gate not found');
      } else {
        const rows = await tx.$queryRaw<{ active: boolean }[]>`
          SELECT active FROM places
           WHERE id = ${post.placeId}::uuid FOR SHARE`;
        if (!rows[0]?.active)
          throw appError.notFound(
            ErrorCode.PLACE_NOT_FOUND,
            'Place not found',
            {
              params: { field: 'zoneId' },
            },
          );
      }
      if (
        await tx.guardShift.count({ where: { guardAccountId, endedAt: null } })
      )
        throw shiftAlreadyOpen();
      const id = newId();
      await this.idempotency.claim(tx, { type: SHIFT_RESOURCE, id });
      const startedAt = await dbNow(tx);
      try {
        await tx.guardShift.create({
          data: { id, tenantId, guardAccountId, ...post, startedAt },
        });
      } catch (error) {
        // A concurrent start without a key: the partial unique index.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw shiftAlreadyOpen();
        throw error;
      }
      await this.audit.record(tx, {
        action: 'gate.shift_started',
        targetId: id,
        metadata: post.gateId
          ? { gateId: post.gateId }
          : { placeId: post.placeId },
      });
      for (const handler of this.started)
        await handler(tx, { id, guardAccountId, ...post, startedAt });
      return this.record(tx, id);
    });
  }

  /**
   * The guard ends their shift, handing over (ADR 0050): the end hooks
   * check the checklist and record it. `Idempotency-Key`: a retry replays
   * the ended shift.
   */
  end(input: ShiftEndInput = {}): Promise<ShiftRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const open = await this.requireOnDuty(tx);
      await this.idempotency.claim(tx, { type: SHIFT_RESOURCE, id: open.id });
      await this.close(tx, open.id, 'guard', input);
      return this.record(tx, open.id);
    });
  }

  /** A gate deactivated: its open shifts end with it. */
  endAllAt(
    tx: TenantTxClient,
    gateId: string,
    reason: string,
  ): Promise<number> {
    return this.endWhere(tx, { gateId }, reason);
  }

  /** A zone retired: its open shifts end with it (ADR 0050). */
  endAllInZone(
    tx: TenantTxClient,
    placeId: string,
    reason: string,
  ): Promise<number> {
    return this.endWhere(tx, { placeId }, reason);
  }

  private async endWhere(
    tx: TenantTxClient,
    where: { gateId: string } | { placeId: string },
    reason: string,
  ): Promise<number> {
    const open = await tx.guardShift.findMany({
      where: { ...where, endedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const s of open) await this.close(tx, s.id, reason);
    return open.length;
  }

  private async close(
    tx: TenantTxClient,
    shiftId: string,
    reason: string,
    handover: ShiftEndInput | null = null,
  ): Promise<void> {
    const endedAt = await dbNow(tx);
    const { count } = await tx.guardShift.updateMany({
      where: { id: shiftId, endedAt: null },
      data: { endedAt, endReason: reason },
    });
    if (!count) return;
    await this.audit.record(tx, {
      action: 'gate.shift_ended',
      targetId: shiftId,
      metadata: { reason },
    });
    const s = await tx.guardShift.findUniqueOrThrow({
      where: { id: shiftId },
      select: DUTY_SELECT,
    });
    for (const handler of this.ended)
      await handler(tx, { ...s, endedAt, reason, handover });
  }

  private async record(tx: TenantTxClient, id: string): Promise<ShiftRecord> {
    const s = await tx.guardShift.findUniqueOrThrow({
      where: { id },
      include: {
        gate: { select: { name: true } },
        place: { select: { id: true, key: true, nameEn: true, nameAr: true } },
      },
    });
    const slot = await tx.guardRosterSlot.findFirst({
      where: { shiftId: id },
      select: { startsAt: true, endsAt: true, lateMinutes: true },
    });
    const pendingHandovers = s.endedAt
      ? 0
      : await tx.guardHandover.count({
          where: {
            ...(s.gateId ? { gateId: s.gateId } : { placeId: s.placeId }),
            acknowledgedAt: null,
            guardAccountId: { not: s.guardAccountId },
            createdAt: { gte: new Date(Date.now() - PENDING_HANDOVER_MS) },
          },
        });
    return {
      id: s.id,
      gateId: s.gateId,
      gateName: s.gate?.name ?? null,
      zone: s.place,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      slot,
      pendingHandovers,
    };
  }
}

/** A gate or a zone, exactly one (VALIDATION_FAILED otherwise). */
export function shiftPostOf(input: {
  gateId?: string;
  zoneId?: string;
}): ShiftPost {
  if (input.gateId && !input.zoneId)
    return { gateId: input.gateId, placeId: null };
  if (input.zoneId && !input.gateId)
    return { gateId: null, placeId: input.zoneId };
  throw invalid(
    input.gateId
      ? [{ field: 'zoneId', code: FieldErrorCode.FIELD_NOT_ALLOWED }]
      : [{ field: 'gateId', code: FieldErrorCode.FIELD_REQUIRED }],
  );
}

function shiftAlreadyOpen() {
  return appError.conflict(
    ErrorCode.SHIFT_ALREADY_OPEN,
    'End the open shift before starting another',
  );
}
