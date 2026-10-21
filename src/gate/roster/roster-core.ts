import { Injectable } from '@nestjs/common';
import type { GuardRosterSlot, GuardRosterTemplate } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import {
  addDays,
  localDate,
  zonedInstant,
} from '../../core/common/slots/day-slots';
import type { WeeklySchedule } from '../../core/common/slots/weekly-schedule';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { shiftPostOf, type ShiftPost } from '../shifts/shifts.service';
import { dbNow } from '../db-clock';
import {
  dayCount,
  fills,
  HORIZON_DAYS,
  lateMinutesOf,
  MAX_RANGE_DAYS,
  occurrences,
  overlaps,
  type Interval,
} from './roster-rules';

/** A period of the compound's days, and the instants it covers. */
export interface Period {
  from: string;
  to: string;
  /** The first day's first instant. */
  start: Date;
  /** The first instant after the last day. */
  end: Date;
}

/** A gate or a zone, as a request names it. */
export interface PostInput {
  gateId?: string;
  zoneId?: string;
}

export type SlotCancelReason =
  | 'schedule_change'
  | 'guard_unavailable'
  | 'post_closed'
  | 'other'
  | 'template_ended'
  | 'guard_left';

/** Runs in the cancelling transaction, after the slot row is cancelled. */
export type SlotCancelHandler = (
  tx: TenantTxClient,
  slot: GuardRosterSlot,
) => Promise<void>;

const iso = (d: Date) => d.toISOString();

/**
 * What the roster's writers share (ADR 0050).
 *
 * **One writer at a time per guard.** Every write to a guard's slots or
 * templates takes, in this order, the guard's account row FOR SHARE and
 * then an advisory lock on the guard (`lockGuard`). The account first: a
 * deactivation holds that row FOR UPDATE before it reaches the roster, and
 * a slot's foreign key needs the row too, so the other order could
 * deadlock. Under the lock, a guard's slots never overlap one another nor
 * the slots their templates will make (`assertFree`): no EXCLUDE
 * constraint is needed, and none would see the slots still to come.
 */
@Injectable()
export class RosterCore {
  private readonly cancelHandlers: SlotCancelHandler[] = [];

  constructor(
    private readonly ctx: RequestContext,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
  ) {}

  /** The swaps follow a slot cancelled (ADR 0050). */
  onSlotCancelled(handler: SlotCancelHandler): void {
    this.cancelHandlers.push(handler);
  }

  async timeZone(tx: TenantTxClient): Promise<string> {
    return (await this.settings.inTx(tx, this.ctx.txTenantId)).timezone;
  }

  /**
   * The compound's days `from` … `to`, inclusive, at most MAX_RANGE_DAYS.
   * Absent, `from` is `back` days before today and `to` is `span` days
   * after `from`.
   */
  async period(
    tx: TenantTxClient,
    q: { from?: string; to?: string },
    defaults: { back: number; span: number } = { back: 0, span: 13 },
  ): Promise<Period> {
    const tz = await this.timeZone(tx);
    const from =
      q.from ?? addDays(localDate(await dbNow(tx), tz), -defaults.back);
    const to = q.to ?? addDays(from, defaults.span);
    const fields: Parameters<typeof invalid>[0] = [];
    if (!isCalendarDay(from))
      fields.push({ field: 'from', code: FieldErrorCode.INVALID_VALUE });
    if (!isCalendarDay(to))
      fields.push({ field: 'to', code: FieldErrorCode.INVALID_VALUE });
    else if (to < from)
      fields.push({ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START });
    else if (dayCount(from, to) > MAX_RANGE_DAYS)
      fields.push({
        field: 'to',
        code: FieldErrorCode.PERIOD_TOO_LONG,
        params: { maxDays: MAX_RANGE_DAYS },
      });
    if (fields.length) throw invalid(fields);
    return {
      from,
      to,
      start: midnight(from, tz),
      end: midnight(addDays(to, 1), tz),
    };
  }

  /**
   * The guard's account FOR SHARE, then the guard's roster lock. Returns
   * whether the account is an active `gate.operate` holder.
   */
  async lockGuard(tx: TenantTxClient, guardId: string): Promise<boolean> {
    const [row] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${guardId}::uuid FOR SHARE`;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`roster-guard:${this.ctx.txTenantId}:${guardId}`}))`;
    if (row?.status !== 'active') return false;
    return (
      (await tx.account.count({
        where: {
          id: guardId,
          role: { permissions: { some: { permission: 'gate.operate' } } },
        },
      })) > 0
    );
  }

  /** Several guards, in id order: two writers never wait on each other. */
  async lockGuards(
    tx: TenantTxClient,
    guardIds: readonly string[],
  ): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    for (const id of [...new Set(guardIds)].sort())
      out.set(id, await this.lockGuard(tx, id));
    return out;
  }

  /** The guard locked and eligible, or GUARD_NOT_ELIGIBLE on `field`. */
  async requireGuard(
    tx: TenantTxClient,
    guardId: string,
    field = 'guardId',
  ): Promise<void> {
    if (!(await this.lockGuard(tx, guardId)))
      throw invalid([{ field, code: FieldErrorCode.GUARD_NOT_ELIGIBLE }]);
  }

  /**
   * A gate or a zone (exactly one) in service, read FOR SHARE: a gate
   * deactivated or a zone retired waits for the write that names it.
   */
  async requirePost(tx: TenantTxClient, input: PostInput): Promise<ShiftPost> {
    const post = shiftPostOf(input);
    if (post.gateId) {
      const [row] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM gates
         WHERE id = ${post.gateId}::uuid FOR SHARE`;
      if (row?.status !== 'active')
        throw invalid([
          { field: 'gateId', code: FieldErrorCode.POST_NOT_AVAILABLE },
        ]);
    } else {
      const [row] = await tx.$queryRaw<{ active: boolean }[]>`
        SELECT active FROM places WHERE id = ${post.placeId}::uuid FOR SHARE`;
      if (!row?.active)
        throw invalid([
          { field: 'zoneId', code: FieldErrorCode.POST_NOT_AVAILABLE },
        ]);
    }
    return post;
  }

  /**
   * The guard is free over `interval`: no scheduled slot of theirs, and no
   * slot one of their live templates will make, overlaps it. The caller
   * holds the guard's lock. ROSTER_OVERLAP names the clash.
   */
  async assertFree(
    tx: TenantTxClient,
    guardId: string,
    interval: Interval,
    timeZone: string,
    ignore: { slotIds?: readonly string[]; templateId?: string } = {},
  ): Promise<void> {
    const clash = await tx.guardRosterSlot.findFirst({
      where: {
        guardAccountId: guardId,
        status: 'scheduled',
        startsAt: { lt: interval.endsAt },
        endsAt: { gt: interval.startsAt },
        ...(ignore.slotIds?.length
          ? { id: { notIn: [...ignore.slotIds] } }
          : {}),
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    if (clash) throw overlap(clash);
    const templates = await tx.guardRosterTemplate.findMany({
      where: {
        guardAccountId: guardId,
        endedAt: null,
        ...(ignore.templateId ? { id: { not: ignore.templateId } } : {}),
      },
    });
    for (const t of templates) {
      const coming = this.occurrencesOf(
        t,
        addDays(localDate(interval.startsAt, timeZone), -1),
        localDate(interval.endsAt, timeZone),
        timeZone,
      ).filter((o) => overlaps(o, interval));
      for (const o of coming) {
        // Made already: checked above while it is still this guard's, and
        // free otherwise (cancelled, or swapped to someone else).
        const made = await tx.guardRosterSlot.count({
          where: { templateId: t.id, startsAt: o.startsAt },
        });
        if (!made) throw overlap(o);
      }
    }
  }

  /** A template's slots on the days `from` … `to`. */
  occurrencesOf(
    t: Pick<
      GuardRosterTemplate,
      'schedule' | 'effectiveFrom' | 'effectiveUntil'
    >,
    from: string,
    to: string,
    timeZone: string,
  ): Interval[] {
    return occurrences(
      t.schedule as unknown as WeeklySchedule,
      {
        from: dateOnly(t.effectiveFrom),
        until: t.effectiveUntil ? dateOnly(t.effectiveUntil) : null,
      },
      from,
      to,
      timeZone,
    );
  }

  /**
   * Makes a live template's slots that have not ended by `now`, up to
   * HORIZON_DAYS ahead, each once (a unique index backs it). One already
   * started (a template made during its window) is due from `now`, and the
   * guard's open shift at its post fills it. The caller holds the guard's
   * lock. A slot that would overlap one of the guard's (a swap gave them
   * one meanwhile) is not made. Returns how many were.
   */
  async materialize(
    tx: TenantTxClient,
    t: GuardRosterTemplate,
    now: Date,
    timeZone: string,
  ): Promise<number> {
    if (t.endedAt) return 0;
    const today = localDate(now, timeZone);
    // From yesterday: a night window that started then runs on today.
    const coming = this.occurrencesOf(
      t,
      addDays(today, -1),
      addDays(today, HORIZON_DAYS),
      timeZone,
    ).filter((o) => o.endsAt > now);
    if (!coming.length) return 0;
    const made = new Set(
      (
        await tx.guardRosterSlot.findMany({
          where: {
            templateId: t.id,
            startsAt: { in: coming.map((o) => o.startsAt) },
          },
          select: { startsAt: true },
        })
      ).map((s) => s.startsAt.getTime()),
    );
    let count = 0;
    for (const o of coming) {
      if (made.has(o.startsAt.getTime())) continue;
      const clash = await tx.guardRosterSlot.count({
        where: {
          guardAccountId: t.guardAccountId,
          status: 'scheduled',
          startsAt: { lt: o.endsAt },
          endsAt: { gt: o.startsAt },
        },
      });
      if (clash) continue;
      const slot = await tx.guardRosterSlot.create({
        data: {
          id: newId(),
          tenantId: t.tenantId,
          guardAccountId: t.guardAccountId,
          gateId: t.gateId,
          placeId: t.placeId,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          templateId: t.id,
          // By the caller's clock: when it is due counts from here.
          createdAt: now,
        },
      });
      await this.fillFromOpenShift(tx, slot, now);
      count++;
    }
    return count;
  }

  /**
   * A slot just made, filled by its guard's shift already open at its post
   * when a shift opening `now` would fill it: that shift opened before the
   * slot existed, so its start hook could not. It opened before the slot
   * was due, so it is not late. The shift is read FOR SHARE while open: an
   * end holding it finished first (and there is nothing to fill), or waits
   * and records this slot. The caller holds the guard's lock (the start
   * hook's order: account, guard, then the shift).
   */
  async fillFromOpenShift(
    tx: TenantTxClient,
    slot: GuardRosterSlot,
    now: Date,
  ): Promise<GuardRosterSlot> {
    if (!fills(slot, now)) return slot;
    const [shift] = await tx.$queryRaw<{ id: string; started_at: Date }[]>`
      SELECT id, started_at FROM guard_shifts
       WHERE guard_account_id = ${slot.guardAccountId}::uuid
         AND ended_at IS NULL
         AND gate_id IS NOT DISTINCT FROM ${slot.gateId}::uuid
         AND place_id IS NOT DISTINCT FROM ${slot.placeId}::uuid
       FOR SHARE`;
    if (!shift) return slot;
    // It fills one slot at most (a unique index backs it).
    if (await tx.guardRosterSlot.count({ where: { shiftId: shift.id } }))
      return slot;
    return tx.guardRosterSlot.update({
      where: { id: slot.id },
      data: {
        shiftId: shift.id,
        lateMinutes: lateMinutesOf(slot, shift.started_at),
      },
    });
  }

  /**
   * Cancels a scheduled slot nobody opened: the caller holds the slot's
   * row (a cancel frees time, so it needs no guard lock). `by` is null for
   * the system's reasons.
   */
  async cancelSlot(
    tx: TenantTxClient,
    slot: GuardRosterSlot,
    reason: SlotCancelReason,
    by: string | null,
    at: Date,
  ): Promise<GuardRosterSlot> {
    const cancelled = await tx.guardRosterSlot.update({
      where: { id: slot.id },
      data: {
        status: 'cancelled',
        cancelledAt: at,
        cancelledById: by,
        cancelReason: reason,
      },
    });
    await this.audit.record(tx, {
      action: 'guard_roster.slot_cancelled',
      targetId: slot.id,
      metadata: { reason },
    });
    for (const handler of this.cancelHandlers) await handler(tx, cancelled);
    return cancelled;
  }

  /** The slot's row FOR UPDATE, or null. */
  async lockSlot(
    tx: TenantTxClient,
    id: string,
  ): Promise<GuardRosterSlot | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_roster_slots WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) return null;
    return tx.guardRosterSlot.findUniqueOrThrow({ where: { id } });
  }
}

/** A real calendar day (`2026-02-30` is not). */
export function isCalendarDay(day: string): boolean {
  return addDays(day, 0) === day;
}

/** The first instant of a compound day (a day the clock skips starts later). */
export function midnight(day: string, tz: string): Date {
  for (let m = 0; m < 180; m++) {
    const at = zonedInstant(day, m, tz);
    if (at) return at;
  }
  throw new Error(`No instant for ${day} in ${tz}`);
}

/** A `@db.Date` column as the compound's day, `YYYY-MM-DD`. */
export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

function overlap(i: Interval) {
  return appError.conflict(
    ErrorCode.ROSTER_OVERLAP,
    'The guard is scheduled then already',
    { params: { startsAt: iso(i.startsAt), endsAt: iso(i.endsAt) } },
  );
}
