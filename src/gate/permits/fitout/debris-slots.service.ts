import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PermitDebrisSlot, UnitPermit } from '@prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { RequestContext } from '../../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../../core/common/errors';
import {
  REASON_CODES,
  requireReasonCodeOnly,
} from '../../../core/common/reasons';
import {
  localDate,
  zonedInstant,
  type LocalDate,
} from '../../../core/common/slots/day-slots';
import { newId } from '../../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../../core/database/tenant-tx.service';
import { SweepRunner } from '../../../core/sweep/sweep-runner';
import { dbNow } from '../../db-clock';
import { ShiftsService } from '../../shifts/shifts.service';
import { PermitCore } from '../permit-core';
import { isWorkDay, minuteOf, timeOf } from '../permit-rules';
import { PermitSettingsService } from '../permit-settings.service';
import { FitOutAccess, type FitOutSide } from './fitout-access';

export const DEBRIS_MISSED_SWEEP = 'permits.debris_missed';
/** Scheduled at once on a permit, at most (ADR 0074). */
export const MAX_SCHEDULED_SLOTS = 3;
/** A window's length, in minutes. */
export const SLOT_MINUTES = { min: 30, max: 240 } as const;
/** How early before its window a removal may be marked done. */
const DONE_EARLY_MS = 30 * 60_000;
/** How long past its window nobody marking it makes it missed. */
export const MISSED_AFTER_MS = 2 * 3_600_000;
const BATCH = 200;

export interface NewDebrisSlot {
  day: LocalDate;
  window: { from: string; to: string };
}

const slotNotFound = () =>
  appError.notFound(
    ErrorCode.DEBRIS_SLOT_NOT_FOUND,
    'Debris removal not found',
  );

/**
 * A works permit's debris removals (ADR 0074). The household (the
 * requester, the unit's primary) or the management schedules a window of
 * an approved works permit that has not ended: a local day of its period
 * that is a work day of the compound, inside its hours, 30 minutes to four
 * hours, starting ahead; three scheduled at once at most, never two
 * overlapping. The management or a guard on shift marks one done from
 * half an hour before its window; the sweep marks missed one nobody marked
 * two hours past its end, and tells the requester and whoever manages
 * permits. Whoever scheduled it (their side) or the management calls one
 * off before it starts, with a code.
 *
 * Every write in the fit-out's lock order (FitOutAccess); a guard's shift
 * FOR SHARE first (ADR 0056: the account, then the shift), so a shift's end
 * waits for the write. The sweep locks the permit's unit and row, then the
 * removal, and judges it again: a mark holding the lock wins.
 */
@Injectable()
export class DebrisSlotsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: FitOutAccess,
    private readonly core: PermitCore,
    private readonly settings: PermitSettingsService,
    private readonly shifts: ShiftsService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(DEBRIS_MISSED_SWEEP, (now) => this.missed(now));
  }

  schedule(
    permitId: string,
    side: FitOutSide,
    input: NewDebrisSlot,
  ): Promise<void> {
    const from = minuteOf(input.window.from);
    const to = minuteOf(input.window.to);
    if (to - from < SLOT_MINUTES.min || to - from > SLOT_MINUTES.max)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid', {
        fields: [
          {
            field: 'window.to',
            code:
              to <= from
                ? FieldErrorCode.ENDS_BEFORE_START
                : FieldErrorCode.INVALID_VALUE,
            ...(to <= from ? {} : { params: { ...SLOT_MINUTES } }),
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.access.write(tx, permitId, side, true);
      if (p.status !== 'approved')
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_ACTIVE,
          'Only an approved works permit has debris removals',
          { params: { status: p.status } },
        );
      const zone = await this.core.timeZone(tx);
      // As they stand now: a change after it binds the next removal only.
      const rules = await this.settings.rules(tx, p.tenantId);
      const now = await dbNow(tx);
      const first = localDate(p.startsAt, zone);
      const last = localDate(new Date(p.endsAt.getTime() - 1), zone);
      const startsAt = zonedInstant(input.day, from, zone);
      const endsAt = zonedInstant(input.day, to, zone);
      const fields: FieldError[] = [];
      if (input.day < first || input.day > last || !isWorkDay(rules, input.day))
        fields.push({
          field: 'day',
          code: FieldErrorCode.DAY_OUT_OF_RANGE,
          params: { min: first, max: last },
        });
      if (from < rules.workFrom || to > rules.workTo)
        fields.push({
          field: 'window',
          code: FieldErrorCode.INVALID_VALUE,
          params: {
            from: timeOf(rules.workFrom),
            to: timeOf(rules.workTo),
          },
        });
      // A window that has begun, or a time the clock skips (daylight saving).
      if (!startsAt || !endsAt || startsAt.getTime() <= now.getTime())
        fields.push({
          field: 'window.from',
          code: FieldErrorCode.INVALID_VALUE,
        });
      if (fields.length)
        throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid', {
          fields,
        });
      const open = await tx.permitDebrisSlot.findMany({
        where: { permitId: p.id, status: 'scheduled' },
      });
      if (open.length >= MAX_SCHEDULED_SLOTS)
        throw appError.conflict(
          ErrorCode.DEBRIS_SLOT_LIMIT,
          'As many removals are scheduled as may be',
          { params: { max: MAX_SCHEDULED_SLOTS } },
        );
      if (
        open.some(
          (o) =>
            o.startsAt.getTime() < endsAt!.getTime() &&
            startsAt!.getTime() < o.endsAt.getTime(),
        )
      )
        throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid', {
          fields: [{ field: 'window', code: FieldErrorCode.DUPLICATE_VALUE }],
        });
      const slot = await tx.permitDebrisSlot.create({
        data: {
          id: newId(),
          tenantId: p.tenantId,
          permitId: p.id,
          day: new Date(`${input.day}T00:00:00.000Z`),
          fromMinute: from,
          toMinute: to,
          startsAt: startsAt!,
          endsAt: endsAt!,
          scheduledBy: this.ctx.accountId,
          scheduledSide: side,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'debris_slot.scheduled',
        targetId: slot.id,
        metadata: {
          permitId: p.id,
          day: input.day,
          from: input.window.from,
          to: input.window.to,
          side,
        },
      });
    });
  }

  /** Called off before it starts: whoever scheduled it on their side, or the management. */
  cancel(
    permitId: string,
    slotId: string,
    side: FitOutSide,
    input: { reasonCode?: string },
  ): Promise<void> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.debrisSlotCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.access.write(tx, permitId, side, false);
      const slot = await this.lockSlot(tx, p, slotId);
      const now = await dbNow(tx);
      // The household calls off its own; the management any.
      if (side === 'resident' && slot.scheduledSide !== 'resident')
        throw appError.forbidden(
          ErrorCode.PERMIT_NOT_ALLOWED,
          'The management scheduled this removal: it calls it off',
        );
      if (
        slot.status !== 'scheduled' ||
        slot.startsAt.getTime() <= now.getTime()
      )
        throw closed(slot);
      await tx.permitDebrisSlot.update({
        where: { id: slot.id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: this.ctx.accountId,
          cancelSide: side,
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'debris_slot.cancelled',
        targetId: slot.id,
        metadata: { permitId: p.id, side, reasonCode: reason },
      });
    });
  }

  /**
   * Marked done, from half an hour before its window until the sweep
   * marked it missed: the management, or a guard on shift (`gate`).
   */
  done(
    permitId: string,
    slotId: string,
    side: 'staff' | 'gate',
  ): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      // ADR 0056's lock order: the account, then the shift. Another
      // compound's permit, or none, is not found before the shift is asked.
      if (side === 'gate') {
        await this.access.read(tx, permitId, 'staff');
        await this.core.lockSelf(tx);
        await this.shifts.requireOnDutyLocked(tx);
      }
      const p = await this.access.write(tx, permitId, 'staff', false);
      const slot = await this.lockSlot(tx, p, slotId);
      const now = await dbNow(tx);
      if (slot.status !== 'scheduled') throw closed(slot);
      if (slot.startsAt.getTime() - DONE_EARLY_MS > now.getTime())
        throw appError.conflict(
          ErrorCode.DEBRIS_SLOT_CLOSED,
          'Its window has not come',
          {
            params: {
              status: 'scheduled',
              startsAt: slot.startsAt.toISOString(),
            },
          },
        );
      await tx.permitDebrisSlot.update({
        where: { id: slot.id },
        data: {
          status: 'done',
          doneAt: now,
          doneBy: this.ctx.accountId,
          doneSide: side,
        },
      });
      await this.audit.record(tx, {
        action: 'debris_slot.done',
        targetId: slot.id,
        metadata: { permitId: p.id, side },
      });
    });
  }

  /** A permit's removals, by their window. */
  of(tx: TenantTxClient, permitId: string): Promise<PermitDebrisSlot[]> {
    return tx.permitDebrisSlot.findMany({
      where: { permitId },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** At the gate: the permit's removals scheduled today. */
  today(permitId: string): Promise<PermitDebrisSlot[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.access.read(tx, permitId, 'staff');
      await this.shifts.requireOnDuty(tx);
      const zone = await this.core.timeZone(tx);
      const today = localDate(await dbNow(tx), zone);
      return tx.permitDebrisSlot.findMany({
        where: {
          permitId: p.id,
          status: 'scheduled',
          day: new Date(`${today}T00:00:00.000Z`),
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      });
    });
  }

  /**
   * The sweep: removals scheduled two hours past their window and never
   * marked are missed, each in a transaction of its own, under the
   * permit's unit lock and row, judged again. The requester and whoever
   * manages permits are told.
   */
  missed(now: Date): Promise<number> {
    const due = new Date(now.getTime() - MISSED_AFTER_MS);
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const rows = await tx.permitDebrisSlot.findMany({
          where: { status: 'scheduled', endsAt: { lte: due } },
          select: { id: true },
          orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        return rows.map((r) => r.id);
      },
      async (tx: TenantTxClient, _tenantId, id: string) => {
        const peek = await tx.permitDebrisSlot.findUnique({ where: { id } });
        if (!peek) return 0;
        const permit = await tx.unitPermit.findUniqueOrThrow({
          where: { id: peek.permitId },
        });
        await this.core.lockUnit(tx, permit.unitId);
        await tx.$queryRaw`
          SELECT id FROM unit_permits WHERE id = ${permit.id}::uuid FOR UPDATE`;
        const slot = await this.lockSlot(tx, permit, id);
        const at = await dbNow(tx);
        if (
          slot.status !== 'scheduled' ||
          slot.endsAt.getTime() + MISSED_AFTER_MS > at.getTime()
        )
          return 0;
        await tx.permitDebrisSlot.update({
          where: { id },
          data: { status: 'missed', missedAt: at },
        });
        await this.audit.record(tx, {
          action: 'debris_slot.missed',
          targetId: id,
          metadata: { permitId: permit.id },
        });
        await this.core.notify(
          tx,
          [
            permit.requestedById,
            ...(await this.core.holding(tx, 'permits.manage')),
          ],
          'unit_permit.debris_missed',
          permit.id,
        );
        return 1;
      },
    );
  }

  private async lockSlot(
    tx: TenantTxClient,
    p: UnitPermit,
    slotId: string,
  ): Promise<PermitDebrisSlot> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM permit_debris_slots
       WHERE id = ${slotId}::uuid AND permit_id = ${p.id}::uuid FOR UPDATE`;
    if (!rows.length) throw slotNotFound();
    return tx.permitDebrisSlot.findUniqueOrThrow({ where: { id: slotId } });
  }
}

const closed = (slot: PermitDebrisSlot) =>
  appError.conflict(
    ErrorCode.DEBRIS_SLOT_CLOSED,
    'This removal is done, missed or called off, or its window began',
    { params: { status: slot.status } },
  );
