import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Booking, Facility } from '@prisma/client';
import { CommunityFacilitiesPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  localDate,
  type LocalDate,
  type Slot,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FacilitiesAccess } from '../access';
import { closedOver, closuresBetween } from '../closures/closure-reads';
import { dbNow } from '../db-clock';
import { rulesOf, type FacilityRules } from '../setup/facility-rules';
import {
  FacilitiesService,
  facilityNotFound,
} from '../setup/facilities.service';
import { SuspensionsService } from '../suspensions/suspensions.service';
import { assertCan, COUNTED, HOLDING } from './booking-rules';
import {
  bookableWhen,
  heldIn,
  slotAt,
  slotsOfDate,
  type FacilityCalendar,
  type FacilitySlot,
} from './facility-slots';
import { WEEK_MS, withinQuota } from './quota-window';
import { BookingView } from './views/booking.views';

export const BOOKING_RESOURCE = 'booking';

export interface NewBooking {
  facilityId: string;
  startsAt: Date;
  guests?: number;
}

/** A slot as a resident sees it: free or full, never how full or by whom. */
export interface SlotState extends FacilitySlot {
  state: 'free' | 'full' | 'closed';
  /** The unit asked about holds this slot. */
  mine: boolean;
}

export const bookingNotFound = () =>
  appError.notFound(ErrorCode.BOOKING_NOT_FOUND, 'Booking not found');

const unitNotFound = () =>
  appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const UPCOMING = keysetCursor('startsAt', 'asc');
const PAST = keysetCursor('startsAt', 'desc');

/** The bookable facility's rules, or the reason it takes no booking. */
function bookable(facility: Facility): FacilityRules {
  if (!facility.active) throw facilityNotFound();
  const rules = rulesOf(facility);
  if (!rules)
    throw appError.conflict(
      ErrorCode.FACILITY_NOT_BOOKABLE,
      'A walk-in facility takes no booking',
    );
  return rules;
}

/**
 * Bookings of the compound's facilities, on the residents' side (ADR
 * 0044): what a slot looks like, booking one for a unit, a unit's bookings
 * and cancelling one.
 *
 * Who books: an active resident or family account whose capabilities on
 * the unit carry `bookings` (a resident who lives there, or a member the
 * primary gave `bookings`); the booking is the unit's, for its quotas, and
 * records who made it. Who sees a booking: whoever made it, and the
 * unit's primary — except, during a separation, what others made.
 *
 * Every write takes, in order: the caller's account (FOR SHARE), the
 * unit's advisory lock, the facility's row (FOR SHARE: a change of its
 * rules, hours or peaks waits), the slot's lock row, the booking's row. So
 * a slot never takes more than its capacity, a unit never more than its
 * quota, and two writers on one booking go one at a time.
 */
@Injectable()
export class BookingsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly community: CommunityFacilitiesPort,
    private readonly access: FacilitiesAccess,
    private readonly facilities: FacilitiesService,
    private readonly suspensions: SuspensionsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(BOOKING_RESOURCE, async (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        BookingView.from(
          await tx.booking.findUniqueOrThrow({ where: { id } }),
          this.ctx.accountId,
        ),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** The facility's calendar: its hours and peaks in the compound's time zone. */
  async calendar(
    tx: TenantTxClient,
    facility: Facility,
    rules: FacilityRules,
  ): Promise<FacilityCalendar> {
    const withWindows = await this.facilities.inTx(tx, facility.id);
    const settings = await this.tenantSettings.inTx(tx, facility.tenantId);
    return {
      hours: withWindows.hours,
      peaks: withWindows.peakWindows,
      slotMinutes: rules.slotMinutes,
      timeZone: settings.timezone,
    };
  }

  /** What holds the facility between two instants. */
  holdingBetween(
    tx: TenantTxClient,
    facilityId: string,
    from: Date,
    to: Date,
  ): Promise<Booking[]> {
    return tx.booking.findMany({
      where: {
        facilityId,
        status: { in: [...HOLDING] },
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
    });
  }

  /** How much of the slot is taken: bookings, or people. */
  static taken(
    rules: FacilityRules,
    slot: Slot,
    holding: readonly Booking[],
  ): number {
    const inSlot = heldIn(slot, holding);
    return rules.capacityUnit === 'people'
      ? inSlot.reduce((sum, b) => sum + b.partySize, 0)
      : inSlot.length;
  }

  /**
   * The slots of one local day that may be booked now, each free or full,
   * and (`unitId`) whether that unit holds it. Too soon and too far are
   * left out. Nothing says how full a slot is, or who holds it.
   */
  slots(
    facilityId: string,
    date: LocalDate | undefined,
    unitId?: string,
  ): Promise<{ date: LocalDate; slots: SlotState[] }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (unitId) await this.requirePlace(tx, unitId);
      const facility = await this.facilities.lock(tx, facilityId, 'share');
      const rules = bookable(facility);
      const cal = await this.calendar(tx, facility, rules);
      const now = await dbNow(tx);
      const on = date ?? localDate(now, cal.timeZone);
      const day = slotsOfDate(on, cal).filter(
        (s) => bookableWhen(s, now, rules, cal.timeZone) === null,
      );
      if (!day.length) return { date: on, slots: [] };
      const holding = await this.holdingBetween(
        tx,
        facilityId,
        day[0].startsAt,
        day[day.length - 1].endsAt,
      );
      const closures = await closuresBetween(
        tx,
        facilityId,
        day[0].startsAt,
        day[day.length - 1].endsAt,
      );
      const slots = day.map((slot): SlotState => ({
        ...slot,
        // Closed by a closure in force; full when not even one more
        // booking (or person) fits.
        state: heldIn(slot, closures).length
          ? 'closed'
          : BookingsService.taken(rules, slot, holding) >= rules.capacity
            ? 'full'
            : 'free',
        mine:
          unitId !== undefined &&
          heldIn(slot, holding).some((b) => b.unitId === unitId),
      }));
      return { date: on, slots };
    });
  }

  /**
   * A unit's bookings that the caller sees, upcoming (not yet over, soonest
   * first) or past (latest first).
   */
  forUnit(
    unitId: string,
    q: { scope: 'upcoming' | 'past'; cursor?: string; limit?: number },
  ): Promise<Page<Booking>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requirePlace(tx, unitId);
      const now = await dbNow(tx);
      const whose = (await this.seesUnit(tx, unitId))
        ? {}
        : { bookedById: this.ctx.accountId };
      const page = q.scope === 'upcoming' ? UPCOMING : PAST;
      const limit = clampLimit(q.limit);
      const rows = await tx.booking.findMany({
        where: {
          AND: [
            { unitId, ...whose },
            q.scope === 'upcoming'
              ? { endsAt: { gt: now } }
              : { endsAt: { lte: now } },
            ...page.after(q.cursor),
          ],
        },
        orderBy: page.orderBy,
        take: limit + 1,
      });
      return page.toPage(rows, limit);
    });
  }

  /** One booking the caller sees (see `visible`). */
  get(id: string): Promise<Booking> {
    return this.tenantTx.withTenantTx((tx) => this.visible(tx, id));
  }

  // --------------------------------------------------------------------------
  // Booking
  // --------------------------------------------------------------------------

  /**
   * Books the slot that starts at `startsAt` for the unit: confirmed at
   * once, or pending when the facility requires approval. Under the locks:
   * the caller may book for the unit; the slot is one the hours offer now,
   * not too soon or too far; the unit does not hold it yet; the unit's
   * quota (and its peak quota) keeps every 7 days within bounds; the slot
   * has room for the party.
   */
  book(unitId: string, input: NewBooking): Promise<Booking> {
    const guests = input.guests ?? 0;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: BOOKING_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.access.lockUnit(tx, unitId);
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps) throw unitNotFound();
      if (!caps.bookings)
        throw appError.forbidden(
          ErrorCode.BOOKINGS_NOT_ALLOWED,
          'This person may not book for this unit',
        );
      const suspended = await this.suspensions.current(
        tx,
        unitId,
        await dbNow(tx),
      );
      if (suspended)
        throw appError.forbidden(
          ErrorCode.BOOKINGS_SUSPENDED,
          'The unit may not book for now',
          { params: { until: suspended.endsAt.toISOString() } },
        );
      const facility = await this.facilities.lock(
        tx,
        input.facilityId,
        'share',
      );
      const rules = bookable(facility);
      const party = guests + 1;
      if (guests > rules.maxGuests)
        throw invalid([
          {
            field: 'guests',
            code: FieldErrorCode.BOOKING_TOO_MANY_GUESTS,
            params: { max: rules.maxGuests },
          },
        ]);
      if (rules.capacityUnit === 'people' && party > rules.capacity)
        throw invalid([
          {
            field: 'guests',
            code: FieldErrorCode.BOOKING_PARTY_TOO_LARGE,
            params: { max: rules.capacity - 1 },
          },
        ]);

      const cal = await this.calendar(tx, facility, rules);
      const slot = slotAt(input.startsAt, cal);
      if (!slot)
        throw invalid([
          { field: 'startsAt', code: FieldErrorCode.BOOKING_SLOT_NOT_OFFERED },
        ]);
      const now = await dbNow(tx);
      const when = bookableWhen(slot, now, rules, cal.timeZone);
      if (when === 'too_soon')
        throw invalid([
          {
            field: 'startsAt',
            code: FieldErrorCode.BOOKING_TOO_SOON,
            params: { minutes: rules.minMinutesBefore },
          },
        ]);
      if (when === 'too_far')
        throw invalid([
          {
            field: 'startsAt',
            code: FieldErrorCode.BOOKING_TOO_FAR,
            params: { days: rules.maxDaysAhead },
          },
        ]);

      if (await closedOver(tx, facility.id, slot))
        throw appError.conflict(
          ErrorCode.FACILITY_CLOSED,
          'The facility is closed at that time',
        );

      await this.checkQuota(tx, unitId, facility.id, slot, rules);

      // The slot's lock: bookings of this slot are decided one at a time.
      const taken = await this.lockSlot(tx, facility, rules, slot);
      if (
        taken + (rules.capacityUnit === 'people' ? party : 1) >
        rules.capacity
      )
        throw appError.conflict(
          ErrorCode.BOOKING_SLOT_FULL,
          'This slot is full',
        );

      const status = rules.requiresApproval ? 'pending' : 'confirmed';
      const booking = await tx.booking.create({
        data: {
          id,
          tenantId: facility.tenantId,
          facilityId: facility.id,
          unitId,
          bookedById: this.ctx.accountId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          guests,
          partySize: party,
          peak: slot.peak,
          status,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'booking.created',
        targetId: booking.id,
        metadata: {
          facilityId: facility.id,
          unitId,
          status,
          peak: slot.peak,
          guests,
          startsAt: slot.startsAt.toISOString(),
        },
      });
      return booking;
    });
  }

  /**
   * The unit's quota at the facility, counted under its lock: it does not
   * hold this slot already, and any 7 days that would contain the new start
   * keep within `weeklyQuota` (and, for a peak slot, its peak bookings
   * within `peakQuota`).
   */
  private async checkQuota(
    tx: TenantTxClient,
    unitId: string,
    facilityId: string,
    slot: FacilitySlot,
    rules: FacilityRules,
  ): Promise<void> {
    const around = await tx.booking.findMany({
      where: {
        unitId,
        facilityId,
        status: { in: [...COUNTED] },
        startsAt: {
          gt: new Date(slot.startsAt.getTime() - WEEK_MS),
          lt: new Date(slot.startsAt.getTime() + WEEK_MS),
        },
      },
      select: { startsAt: true, peak: true, status: true },
    });
    if (
      around.some(
        (b) =>
          b.startsAt.getTime() === slot.startsAt.getTime() &&
          (HOLDING as readonly string[]).includes(b.status),
      )
    )
      throw appError.conflict(
        ErrorCode.BOOKING_ALREADY_HELD,
        'The unit already holds this slot',
      );
    if (
      !withinQuota(
        around.map((b) => b.startsAt),
        slot.startsAt,
        rules.weeklyQuota,
      )
    )
      throw appError.conflict(
        ErrorCode.BOOKING_QUOTA_REACHED,
        'The unit has as many bookings here as a week allows',
        { params: { quota: rules.weeklyQuota, peak: false } },
      );
    if (
      slot.peak &&
      !withinQuota(
        around.filter((b) => b.peak).map((b) => b.startsAt),
        slot.startsAt,
        rules.peakQuota,
      )
    )
      throw appError.conflict(
        ErrorCode.BOOKING_QUOTA_REACHED,
        'The unit has as many peak-time bookings here as a week allows',
        { params: { quota: rules.peakQuota, peak: true } },
      );
  }

  /**
   * Takes the slot's lock row (created on first use) and answers how much
   * of the slot is taken by what holds it now. Counted by overlap, so a
   * booking made before the slot length changed still takes its place.
   */
  async lockSlot(
    tx: TenantTxClient,
    facility: Facility,
    rules: FacilityRules,
    slot: Slot,
  ): Promise<number> {
    await this.lockSlotRow(tx, facility, slot.startsAt);
    const holding = await this.holdingBetween(
      tx,
      facility.id,
      slot.startsAt,
      slot.endsAt,
    );
    return BookingsService.taken(rules, slot, holding);
  }

  /** The slot's lock row, created on first use, locked to the end of the transaction. */
  async lockSlotRow(
    tx: TenantTxClient,
    facility: Facility,
    startsAt: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO facility_slot_locks (tenant_id, facility_id, starts_at)
      VALUES (${facility.tenantId}::uuid, ${facility.id}::uuid, ${startsAt})
      ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`
      SELECT starts_at FROM facility_slot_locks
       WHERE tenant_id = ${facility.tenantId}::uuid
         AND facility_id = ${facility.id}::uuid
         AND starts_at = ${startsAt} FOR UPDATE`;
  }

  // --------------------------------------------------------------------------
  // Cancelling
  // --------------------------------------------------------------------------

  /**
   * The booker, or the unit's primary, cancels: a pending booking at any
   * time, a confirmed one until the facility's cutoff before its start.
   */
  cancel(id: string, reasonCode: string | undefined): Promise<Booking> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.bookingResidentCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await this.visible(tx, id);
      await this.access.lockUnit(tx, seen.unitId);
      const facility = await this.facilities.lock(tx, seen.facilityId, 'share');
      const booking = await this.lockBooking(tx, id);
      assertCan(booking, 'cancel');
      const now = await dbNow(tx);
      const rules = rulesOf(facility)!;
      if (
        booking.status === 'confirmed' &&
        now.getTime() >
          booking.startsAt.getTime() - rules.cancelCutoffMinutes * 60_000
      )
        throw appError.conflict(
          ErrorCode.BOOKING_CANCEL_CUTOFF_PASSED,
          'Too late to cancel this booking',
          { params: { minutes: rules.cancelCutoffMinutes } },
        );
      return this.end(tx, booking, {
        side: 'resident',
        reason,
        by: this.ctx.accountId,
        now,
      });
    });
  }

  /** The booking's row, locked; the caller has taken the locks before it. */
  async lockBooking(tx: TenantTxClient, id: string): Promise<Booking> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM bookings WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw bookingNotFound();
    return tx.booking.findUniqueOrThrow({ where: { id } });
  }

  /** Cancels a locked booking that takes the action, and audits it. */
  async end(
    tx: TenantTxClient,
    booking: Booking,
    how: {
      side: 'resident' | 'staff' | 'system';
      reason: string;
      by: string | null;
      now: Date;
      closureId?: string;
    },
  ): Promise<Booking> {
    const ended = await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: 'cancelled',
        cancelledSide: how.side,
        cancelReason: how.reason,
        cancelledById: how.by,
        cancelledAt: how.now,
        closureId: how.closureId,
      },
    });
    await this.audit.record(tx, {
      action: 'booking.cancelled',
      targetId: booking.id,
      metadata: {
        facilityId: booking.facilityId,
        unitId: booking.unitId,
        from: booking.status,
        side: how.side,
        reasonCode: how.reason,
        ...(how.closureId ? { closureId: how.closureId } : {}),
      },
    });
    return ended;
  }

  // --------------------------------------------------------------------------
  // Who sees what
  // --------------------------------------------------------------------------

  /** The caller has a place on the unit, or the unit is not found. */
  private async requirePlace(tx: TenantTxClient, unitId: string) {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps?.unitView) throw unitNotFound();
    return caps;
  }

  /**
   * Whether the caller sees every booking of the unit: its primary, unless
   * the household is under a separation (then a member's activity is not
   * the primary's to see, ADR 0021).
   */
  private async seesUnit(tx: TenantTxClient, unitId: string): Promise<boolean> {
    return (
      (await this.community.isPrimary(tx, this.ctx.accountId, unitId)) &&
      !(await this.community.separated(tx, unitId))
    );
  }

  /**
   * The booking, if the caller sees it: its booker, or (see `seesUnit`) the
   * unit's primary. Anything else is the one not-found.
   */
  private async visible(tx: TenantTxClient, id: string): Promise<Booking> {
    const booking = await tx.booking.findUnique({ where: { id } });
    if (!booking) throw bookingNotFound();
    if (booking.bookedById === this.ctx.accountId) return booking;
    if (await this.seesUnit(tx, booking.unitId)) return booking;
    throw bookingNotFound();
  }
}
