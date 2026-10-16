import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { SafetyCore } from '../safety/safety-core';
import {
  ShiftsService,
  type EndedShift,
  type StartedShift,
} from '../shifts/shifts.service';
import { RosterCore } from './roster-core';
import {
  ABSENT_AFTER_MINUTES,
  endMinutes,
  isLate,
  lateMinutesOf,
  LINK_EARLY_MINUTES,
} from './roster-rules';

export const ROSTER_ATTENDANCE_SWEEP = 'gate.roster_attendance';
export const ROSTER_MATERIALIZE_SWEEP = 'gate.roster_materialize';
/** Often enough that "an hour late" is at most a minute more. */
export const ATTENDANCE_INTERVAL_MS = 60_000;
/** A slot older than this is never marked absent any more (its post was out of service). */
const ABSENCE_LOOKBACK_MS = 2 * 24 * 3_600_000;
const SWEEP_BATCH = 200;
const MINUTE = 60_000;

/**
 * What the roster records of a shift (ADR 0050).
 *
 * - **Opening** (a start hook, in the start's transaction): the guard's
 *   earliest scheduled, unfilled slot at that post whose window takes the
 *   start (30 minutes before it until its end) is filled, with how late the
 *   shift opened; more than ten minutes is audited as late. No slot: the
 *   shift is unscheduled.
 * - **Absence** (a sweep every minute): a slot nobody opened an hour after
 *   its start, at a post still in service, is marked absent once, and the
 *   roster's keepers are told — critically when nobody else is on shift
 *   there. A later opening still fills it: both are recorded.
 * - **Ending** (an end hook, for every end): overtime for a shift that
 *   filled a slot, its length as unscheduled minutes for one that did not.
 */
@Injectable()
export class RosterAttendance implements OnModuleInit {
  constructor(
    private readonly core: RosterCore,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.shifts.onStarted((tx, shift) => this.fill(tx, shift));
    this.shifts.onEnded((tx, shift) => this.recordEnd(tx, shift));
    this.sweep.register(
      ROSTER_ATTENDANCE_SWEEP,
      (now) => this.markAbsent(now),
      { intervalMs: ATTENDANCE_INTERVAL_MS },
    );
    this.sweep.register(ROSTER_MATERIALIZE_SWEEP, (now) =>
      this.materializeDue(now),
    );
  }

  /**
   * The slot this shift fills, taken FOR UPDATE under the guard's lock: an
   * absence being marked, a cancel or a swap holding it finishes first.
   */
  private async fill(tx: TenantTxClient, shift: StartedShift): Promise<void> {
    await this.core.lockGuard(tx, shift.guardAccountId);
    const earliest = new Date(
      shift.startedAt.getTime() + LINK_EARLY_MINUTES * MINUTE,
    );
    const rows = shift.gateId
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM guard_roster_slots
           WHERE guard_account_id = ${shift.guardAccountId}::uuid
             AND gate_id = ${shift.gateId}::uuid
             AND status = 'scheduled' AND shift_id IS NULL
             AND starts_at <= ${earliest} AND ends_at > ${shift.startedAt}
           ORDER BY starts_at, id LIMIT 1 FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM guard_roster_slots
           WHERE guard_account_id = ${shift.guardAccountId}::uuid
             AND place_id = ${shift.placeId}::uuid
             AND status = 'scheduled' AND shift_id IS NULL
             AND starts_at <= ${earliest} AND ends_at > ${shift.startedAt}
           ORDER BY starts_at, id LIMIT 1 FOR UPDATE`;
    if (!rows.length) return;
    const slot = await tx.guardRosterSlot.findUniqueOrThrow({
      where: { id: rows[0].id },
    });
    const lateMinutes = lateMinutesOf(slot.startsAt, shift.startedAt);
    await tx.guardRosterSlot.update({
      where: { id: slot.id },
      data: { shiftId: shift.id, lateMinutes },
    });
    if (isLate(lateMinutes))
      await this.audit.record(tx, {
        action: 'guard_shift.late',
        targetId: shift.id,
        metadata: { slotId: slot.id, minutes: lateMinutes },
      });
  }

  private async recordEnd(
    tx: TenantTxClient,
    shift: EndedShift,
  ): Promise<void> {
    const slot = await tx.guardRosterSlot.findFirst({
      where: { shiftId: shift.id },
      select: { startsAt: true, endsAt: true },
    });
    await tx.guardShift.update({
      where: { id: shift.id },
      data: endMinutes(shift, slot),
    });
  }

  /**
   * Slots nobody opened an hour after their start, one transaction each:
   * the row is taken with SKIP LOCKED and judged again under its lock, so
   * an opening holding it wins. Run twice, or on two instances at once, a
   * slot is marked once (`absent_at` is the claim; the trigger allows it
   * once).
   */
  markAbsent(now: Date): Promise<number> {
    const due = new Date(now.getTime() - ABSENT_AFTER_MINUTES * MINUTE);
    const floor = new Date(now.getTime() - ABSENCE_LOOKBACK_MS);
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.guardRosterSlot.findMany({
            where: {
              status: 'scheduled',
              shiftId: null,
              absentAt: null,
              startsAt: { lte: due, gte: floor },
            },
            orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
            take: SWEEP_BATCH,
            select: { id: true },
          })
        ).map((s) => s.id),
      async (tx, _tenantId, id) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM guard_roster_slots
           WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const slot = await tx.guardRosterSlot.findUniqueOrThrow({
          where: { id },
        });
        if (
          slot.status !== 'scheduled' ||
          slot.shiftId ||
          slot.absentAt ||
          slot.startsAt > due
        )
          return 0;
        // A post out of service is nobody's absence: the slot stays, and is
        // not marked.
        if (!(await this.inService(tx, slot))) return 0;
        await tx.guardRosterSlot.update({
          where: { id },
          data: { absentAt: now },
        });
        const others = await this.safety.guardsOnShift(
          tx,
          slot.gateId ?? { placeId: slot.placeId! },
        );
        const unmanned = others.length === 0;
        const recipients = await this.safety.notify(
          tx,
          await this.safety.holding(tx, 'guard_roster.manage'),
          unmanned ? 'guard_shift.absent_unmanned' : 'guard_shift.absent',
          id,
        );
        await this.audit.record(tx, {
          action: 'guard_shift.absent',
          targetId: id,
          metadata: { unmanned, recipients },
        });
        return 1;
      },
    );
  }

  private async inService(
    tx: TenantTxClient,
    slot: { gateId: string | null; placeId: string | null },
  ): Promise<boolean> {
    if (slot.gateId)
      return (
        (await tx.gate.count({
          where: { id: slot.gateId, status: 'active' },
        })) > 0
      );
    return (
      (await tx.place.count({
        where: { id: slot.placeId!, active: true },
      })) > 0
    );
  }

  /**
   * Keeps every live template's slots made HORIZON_DAYS ahead, one
   * transaction per template under its guard's lock. A template whose guard
   * is no longer an active guard makes nothing (their leaving ends it).
   */
  materializeDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.guardRosterTemplate.findMany({
            where: { endedAt: null },
            orderBy: { id: 'asc' },
            select: { id: true, guardAccountId: true },
          })
        ).map((t) => t),
      async (tx, _tenantId, t) => {
        if (!(await this.core.lockGuard(tx, t.guardAccountId))) return 0;
        const template = await tx.guardRosterTemplate.findUniqueOrThrow({
          where: { id: t.id },
        });
        return this.core.materialize(
          tx,
          template,
          now,
          await this.core.timeZone(tx),
        );
      },
    );
  }
}
