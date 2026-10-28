import { Injectable } from '@nestjs/common';
import type { UnitMove, UnitMoveStep } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  MoveSteps,
  type DerivedMoveStep,
  type MoveRef,
} from '../../core/moves/move-steps';
import { Notifier } from '../../core/notifications/notifier';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { lockAccountShared } from '../residents/account-locks';
import { lockUnits } from '../units/unit-lock';
import {
  MOVE_CHECKLIST,
  manualStep,
  type MoveDirection,
  type StepSide,
} from './move-checklist';

/** A step of a move's checklist, as either side sees it. */
export interface ChecklistStep {
  key: string;
  /** Who ticks it; `derived` is read from the domain that holds it. */
  side: StepSide | 'derived';
  done: boolean;
  at: Date | null;
  /** A derived step's reference (a permit's or a clearance's number). */
  reference: string | null;
}

export interface MoveRead {
  id: string;
  number: number;
  unitId: string;
  occupancyId: string;
  direction: MoveDirection;
  plannedOn: Date;
  status: 'planned' | 'done' | 'cancelled';
  /** Whether a person planned it (else the occupancy's start did). */
  plannedBySomeone: boolean;
  createdAt: Date;
  doneAt: Date | null;
  handoverReason: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

export interface MoveWithChecklist {
  move: MoveRead;
  checklist: ChecklistStep[];
}

/** A move on the management's board: the unit's code beside it. */
export interface BoardMove extends MoveRead {
  unitCode: string;
}

const notFound = () =>
  appError.notFound(ErrorCode.MOVE_NOT_FOUND, 'Move not found');
const notPlanned = () =>
  appError.conflict(
    ErrorCode.MOVE_NOT_PLANNED,
    'The move is done or cancelled',
  );
/** How far ahead a move may be planned. */
const MAX_DAYS_AHEAD = 365;
const DAY_MS = 86_400_000;

function read(m: UnitMove): MoveRead {
  return {
    id: m.id,
    number: m.number,
    unitId: m.unitId,
    occupancyId: m.occupancyId,
    direction: m.direction as MoveDirection,
    plannedOn: m.plannedOn,
    status: m.status as MoveRead['status'],
    plannedBySomeone: m.createdBy !== null,
    createdAt: m.createdAt,
    doneAt: m.doneAt,
    handoverReason: m.handoverReason,
    cancelledAt: m.cancelledAt,
    cancelReason: m.cancelReason,
  };
}

/**
 * Moving in and out of a unit (ADR 0063). A move belongs to an occupancy.
 * A move-in is planned when a residing occupancy begins (today, by the
 * compound's calendar); a move-out by the residing primary's notice — never
 * a delegate's — or by the management (`residents.manage`), one planned
 * each way per occupancy. A move-in is done when the management confirms
 * it; a move-out at the occupancy's handover, which is never blocked: with
 * no clearance, the manager gives a code instead. Either side cancels with
 * a code; an occupancy that ends leaves its planned move-in cancelled.
 *
 * The checklist is a closed list per direction: manual steps ticked once
 * by their side, and derived ones read through `MoveSteps` from gate (a
 * move permit), management (a utilities request) and finance (a
 * clearance, the deposits). Every write takes the unit's lock (after the
 * caller's account, for a resident), then reads the clock.
 */
@Injectable()
export class MovesService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly settings: TenantSettingsService,
    private readonly steps: MoveSteps,
  ) {}

  // --------------------------------------------------------------------------
  // Hooks from the occupancy's life (residents.service.ts), in its transaction
  // and under its unit lock.
  // --------------------------------------------------------------------------

  /** A residing occupancy began: its move-in is planned for today. */
  async occupancyStarted(
    tx: TenantTxClient,
    o: { id: string; unitId: string; resides: boolean; status: string },
  ): Promise<void> {
    if (!o.resides || o.status !== 'active') return;
    const today = await this.localToday(tx);
    const move = await this.create(tx, {
      unitId: o.unitId,
      occupancyId: o.id,
      direction: 'in',
      plannedOn: today,
      createdBy: null,
    });
    await this.recordPlanned(tx, move, 'system');
  }

  /** The occupancy ended: a move-in still planned will not happen. */
  async occupancyEnded(tx: TenantTxClient, occupancyId: string): Promise<void> {
    const planned = await tx.unitMove.findMany({
      where: { occupancyId, direction: 'in', status: 'planned' },
    });
    if (!planned.length) return;
    const now = await dbNow(tx);
    for (const m of planned) {
      await tx.unitMove.update({
        where: { id: m.id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          cancelReason: 'occupancy_ended',
        },
      });
      await this.audit.record(tx, {
        action: 'unit_move.cancelled',
        targetId: m.id,
        metadata: {
          unitId: m.unitId,
          direction: m.direction,
          reasonCode: 'occupancy_ended',
          side: 'system',
        },
      });
    }
  }

  /**
   * The occupancy was handed over: its planned move-out is done. With no
   * clearance on the checklist, the manager says why with a code; the
   * handover still happens (ADR 0063: keys are physical).
   */
  async handedOver(
    tx: TenantTxClient,
    occupancyId: string,
    reasonCode: string | undefined,
  ): Promise<void> {
    const move = await tx.unitMove.findFirst({
      where: { occupancyId, direction: 'out', status: 'planned' },
    });
    if (!move) return;
    const clearance = await this.derived(tx, move, 'clearance_issued');
    let handoverReason: string | null = null;
    if (!clearance.done) {
      if (!reasonCode)
        throw appError.conflict(
          ErrorCode.MOVE_HANDOVER_REASON_REQUIRED,
          'No clearance: say why the unit is handed over',
          { params: { allowed: [...REASON_CODES.handoverWithoutClearance] } },
        );
      handoverReason = requireReasonCodeOnly(
        reasonCode,
        REASON_CODES.handoverWithoutClearance,
      );
    }
    const now = await dbNow(tx);
    await tx.unitMove.update({
      where: { id: move.id },
      data: {
        status: 'done',
        doneAt: now,
        doneBy: this.ctx.accountId,
        handoverReason,
      },
    });
    await this.audit.record(tx, {
      action: 'unit_move.done',
      targetId: move.id,
      metadata: {
        unitId: move.unitId,
        direction: 'out',
        ...(handoverReason ? { reasonCode: handoverReason } : {}),
      },
    });
  }

  // --------------------------------------------------------------------------
  // The resident's side
  // --------------------------------------------------------------------------

  /** The moves of the caller's own occupancies of the unit, newest first. */
  mine(unitId: string): Promise<MoveRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.visibleUnit(tx, unitId);
      const moves = await tx.unitMove.findMany({
        where: { unitId, occupancy: { accountId: this.ctx.accountId } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return moves.map(read);
    });
  }

  /** One of the caller's moves, with its checklist. */
  open(unitId: string, id: string): Promise<MoveWithChecklist> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.visibleUnit(tx, unitId);
      const move = await tx.unitMove.findFirst({
        where: { id, unitId, occupancy: { accountId: this.ctx.accountId } },
      });
      if (!move) throw notFound();
      return { move: read(move), checklist: await this.checklist(tx, move) };
    });
  }

  /**
   * The residing primary gives notice: their move-out is planned for that
   * day. Not delegable (ADR 0062): the primary's own decision.
   */
  noticeMoveOut(
    unitId: string,
    input: { plannedOn: string },
  ): Promise<MoveRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockAccountShared(tx, this.ctx.accountId);
      await lockUnits(tx, [unitId]);
      const occupancy = await tx.unitOccupancy.findFirst({
        where: {
          unitId,
          accountId: this.ctx.accountId,
          status: 'active',
          isPrimary: true,
          resides: true,
        },
      });
      if (!occupancy)
        throw appError.forbidden(
          ErrorCode.MOVE_NOT_ALLOWED,
          'Only the residing primary gives notice to move out',
        );
      const plannedOn = await this.plannedDay(tx, input.plannedOn);
      const move = await this.create(tx, {
        unitId,
        occupancyId: occupancy.id,
        direction: 'out',
        plannedOn,
        createdBy: this.ctx.accountId,
      });
      await this.recordPlanned(tx, move, 'resident');
      const holders = await this.staff.holding(tx, 'residents.manage');
      await this.notifier.notify(
        tx,
        holders.map((h) => h.id),
        {
          kind: 'unit_move.notice_given',
          params: { plannedOn: input.plannedOn },
          targetId: move.id,
        },
      );
      return read(move);
    });
  }

  /** The occupancy's side ticks one of its steps. */
  tickMine(
    unitId: string,
    id: string,
    step: string,
  ): Promise<MoveWithChecklist> {
    return this.tick(id, step, 'resident', { unitId });
  }

  /** The resident withdraws the notice they gave. */
  cancelMine(unitId: string, id: string, reasonCode: string | undefined) {
    return this.cancel(id, reasonCode, { unitId });
  }

  // --------------------------------------------------------------------------
  // The management's side (`residents.manage`)
  // --------------------------------------------------------------------------

  /** Planned moves, the nearest first; or a unit's moves, newest first. */
  board(q: { unitId?: string; status?: string }): Promise<BoardMove[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const moves = await tx.unitMove.findMany({
        where: {
          ...(q.unitId ? { unitId: q.unitId } : {}),
          status: q.status ?? (q.unitId ? undefined : 'planned'),
        },
        orderBy: q.unitId
          ? { createdAt: 'desc' }
          : [{ plannedOn: 'asc' }, { number: 'asc' }],
        take: 200,
        include: { unit: { select: { code: true } } },
      });
      return moves.map((m) => ({ ...read(m), unitCode: m.unit.code }));
    });
  }

  staffOpen(id: string): Promise<MoveWithChecklist> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const move = await tx.unitMove.findUnique({ where: { id } });
      if (!move) throw notFound();
      return { move: read(move), checklist: await this.checklist(tx, move) };
    });
  }

  /** The management plans a move for an active occupancy of the unit. */
  plan(
    unitId: string,
    input: { occupancyId: string; direction: string; plannedOn: string },
  ): Promise<MoveRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const occupancy = await tx.unitOccupancy.findFirst({
        where: { id: input.occupancyId, unitId, status: 'active' },
      });
      if (!occupancy)
        throw appError.notFound(
          ErrorCode.OCCUPANCY_NOT_FOUND,
          'Occupancy not found',
        );
      const plannedOn = await this.plannedDay(tx, input.plannedOn);
      const move = await this.create(tx, {
        unitId,
        occupancyId: occupancy.id,
        direction: input.direction as MoveDirection,
        plannedOn,
        createdBy: this.ctx.accountId,
      });
      await this.recordPlanned(tx, move, 'management');
      return read(move);
    });
  }

  /** The move-in happened: the management confirms it. */
  confirmIn(id: string): Promise<MoveRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const move = await this.locked(tx, id);
      if (move.direction !== 'in')
        throw appError.conflict(
          ErrorCode.MOVE_NOT_PLANNED,
          'A move-out is done at the handover',
        );
      const now = await dbNow(tx);
      const after = await tx.unitMove.update({
        where: { id },
        data: { status: 'done', doneAt: now, doneBy: this.ctx.accountId },
      });
      await this.audit.record(tx, {
        action: 'unit_move.done',
        targetId: id,
        metadata: { unitId: move.unitId, direction: 'in' },
      });
      return read(after);
    });
  }

  tickStaff(id: string, step: string): Promise<MoveWithChecklist> {
    return this.tick(id, step, 'management', {});
  }

  cancelStaff(id: string, reasonCode: string | undefined) {
    return this.cancel(id, reasonCode, {});
  }

  // --------------------------------------------------------------------------

  private async tick(
    id: string,
    step: string,
    side: StepSide,
    mine: { unitId?: string },
  ): Promise<MoveWithChecklist> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (side === 'resident') await lockAccountShared(tx, this.ctx.accountId);
      const move = await this.locked(tx, id, mine);
      const manual = manualStep(move.direction as MoveDirection, step);
      if (!manual || manual.side !== side)
        throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown step', {
          fields: [
            {
              field: 'step',
              code: FieldErrorCode.INVALID_VALUE,
              params: {
                allowed: MOVE_CHECKLIST[move.direction as MoveDirection].manual
                  .filter((s) => s.side === side)
                  .map((s) => s.key),
              },
            },
          ],
        });
      const already = await tx.unitMoveStep.findUnique({
        where: { moveId_step: { moveId: id, step } },
      });
      if (already)
        throw appError.conflict(ErrorCode.MOVE_STEP_DONE, 'Ticked already');
      await tx.unitMoveStep.create({
        data: {
          id: newId(),
          tenantId: move.tenantId,
          moveId: id,
          step,
          side,
          doneBy: this.ctx.accountId,
          doneAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'unit_move.step_done',
        targetId: id,
        metadata: { unitId: move.unitId, step, side },
      });
      return { move: read(move), checklist: await this.checklist(tx, move) };
    });
  }

  private cancel(
    id: string,
    reasonCode: string | undefined,
    mine: { unitId?: string },
  ): Promise<MoveRead> {
    const reason = requireReasonCodeOnly(reasonCode, REASON_CODES.moveCancel);
    return this.tenantTx.withTenantTx(async (tx) => {
      const resident = mine.unitId !== undefined;
      if (resident) await lockAccountShared(tx, this.ctx.accountId);
      const move = await this.locked(tx, id, mine);
      // A resident withdraws only the notice they gave; the occupancy's
      // own move-in is the management's to cancel.
      if (resident && move.createdBy !== this.ctx.accountId)
        throw appError.forbidden(
          ErrorCode.MOVE_NOT_ALLOWED,
          'Only the notice you gave',
        );
      const after = await tx.unitMove.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: await dbNow(tx),
          cancelledBy: this.ctx.accountId,
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'unit_move.cancelled',
        targetId: id,
        metadata: {
          unitId: move.unitId,
          direction: move.direction,
          reasonCode: reason,
          side: resident ? 'resident' : 'management',
        },
      });
      return read(after);
    });
  }

  /** The move under its unit's lock, still planned; a resident's own only. */
  private async locked(
    tx: TenantTxClient,
    id: string,
    mine: { unitId?: string } = {},
  ): Promise<UnitMove> {
    const found = await tx.unitMove.findFirst({
      where: {
        id,
        ...(mine.unitId !== undefined
          ? {
              unitId: mine.unitId,
              occupancy: { accountId: this.ctx.accountId },
            }
          : {}),
      },
      select: { unitId: true },
    });
    if (!found) throw notFound();
    await lockUnits(tx, [found.unitId]);
    const [move] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM unit_moves WHERE id = ${id}::uuid FOR UPDATE`;
    if (!move) throw notFound();
    const m = await tx.unitMove.findUniqueOrThrow({ where: { id } });
    if (m.status !== 'planned') throw notPlanned();
    return m;
  }

  private async create(
    tx: TenantTxClient,
    input: {
      unitId: string;
      occupancyId: string;
      direction: MoveDirection;
      plannedOn: Date;
      createdBy: string | null;
    },
  ): Promise<UnitMove> {
    const planned = await tx.unitMove.findFirst({
      where: {
        occupancyId: input.occupancyId,
        direction: input.direction,
        status: 'planned',
      },
      select: { id: true },
    });
    if (planned)
      throw appError.conflict(
        ErrorCode.MOVE_ALREADY_PLANNED,
        'A move this way is planned already',
      );
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext(${`unit-move-number:${this.ctx.txTenantId}`}), 0)`;
    const last = await tx.unitMove.findFirst({
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    return tx.unitMove.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        number: (last?.number ?? 0) + 1,
        unitId: input.unitId,
        occupancyId: input.occupancyId,
        direction: input.direction,
        plannedOn: input.plannedOn,
        createdBy: input.createdBy,
        createdAt: await dbNow(tx),
      },
    });
  }

  private recordPlanned(
    tx: TenantTxClient,
    m: UnitMove,
    side: 'system' | 'resident' | 'management',
  ) {
    return this.audit.record(tx, {
      action: 'unit_move.planned',
      targetId: m.id,
      metadata: {
        unitId: m.unitId,
        occupancyId: m.occupancyId,
        direction: m.direction,
        side,
      },
    });
  }

  private async checklist(
    tx: TenantTxClient,
    move: UnitMove & { steps?: UnitMoveStep[] },
  ): Promise<ChecklistStep[]> {
    const direction = move.direction as MoveDirection;
    const ticked = await tx.unitMoveStep.findMany({
      where: { moveId: move.id },
    });
    const manual = MOVE_CHECKLIST[direction].manual.map((s) => {
      const t = ticked.find((x) => x.step === s.key);
      return {
        key: s.key,
        side: s.side,
        done: !!t,
        at: t?.doneAt ?? null,
        reference: null,
      };
    });
    const derived: ChecklistStep[] = [];
    for (const step of MOVE_CHECKLIST[direction].derived) {
      const state = await this.derived(tx, move, step);
      derived.push({ key: step, side: 'derived', ...state });
    }
    return [...manual, ...derived];
  }

  private async derived(
    tx: TenantTxClient,
    move: UnitMove,
    step: DerivedMoveStep,
  ) {
    const occupancy = await tx.unitOccupancy.findUniqueOrThrow({
      where: { id: move.occupancyId },
      select: { accountId: true },
    });
    const ref: MoveRef = {
      id: move.id,
      unitId: move.unitId,
      occupancyId: move.occupancyId,
      accountId: occupancy.accountId,
      direction: move.direction as MoveDirection,
      createdAt: move.createdAt,
    };
    return this.steps.reader(step)(tx, ref);
  }

  /** Another compound's unit, or none, is the one not-found. */
  private async visibleUnit(tx: TenantTxClient, unitId: string) {
    const unit = await tx.unit.findUnique({
      where: { id: unitId },
      select: { id: true },
    });
    if (!unit)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
  }

  /** A day from today to a year ahead, on the compound's calendar. */
  private async plannedDay(tx: TenantTxClient, value: string): Promise<Date> {
    const day = new Date(`${value}T00:00:00.000Z`);
    const today = await this.localToday(tx);
    if (
      Number.isNaN(day.getTime()) ||
      day < today ||
      day.getTime() > today.getTime() + MAX_DAYS_AHEAD * DAY_MS
    )
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid day', {
        fields: [
          {
            field: 'plannedOn',
            code: FieldErrorCode.INVALID_VALUE,
            params: { min: 'today', maxDaysAhead: MAX_DAYS_AHEAD },
          },
        ],
      });
    return day;
  }

  private async localToday(tx: TenantTxClient): Promise<Date> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    const [{ today }] = await tx.$queryRaw<{ today: Date }[]>`
      SELECT (clock_timestamp() AT TIME ZONE ${timezone})::date AS today`;
    return today;
  }
}
