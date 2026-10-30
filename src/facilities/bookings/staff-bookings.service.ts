import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Booking, BookingStatus } from '@prisma/client';
import { CommunityFacilitiesPort, type FacilityAccount } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  addDays,
  localDate,
  zonedInstant,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { FacilitiesAccess } from '../access';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';
import { rulesOf, type FacilityRules } from '../setup/facility-rules';
import { FacilitiesService } from '../setup/facilities.service';
import { SuspensionsService } from '../suspensions/suspensions.service';
import { assertCan, HOLDING } from './booking-rules';
import { BookingsService, bookingNotFound } from './bookings.service';
import { slotsOfDate, type FacilitySlot } from './facility-slots';

export const BOOKING_EXPIRE_SWEEP = 'bookings.expire_pending';
/** A no-show is marked within three days of the slot's end. */
export const NO_SHOW_HOURS = 72;
const HOUR = 3_600_000;
const BATCH = 500;

/** A booking with what a staff view names: the unit's code and the booker. */
export interface StaffBooking {
  booking: Booking;
  unitCode: string;
  bookedBy: FacilityAccount;
}

export interface StaffBookingsQuery {
  status?: BookingStatus;
  facilityId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface FacilityDay {
  date: LocalDate;
  rules: FacilityRules;
  slots: (FacilitySlot & { taken: number })[];
  bookings: StaffBooking[];
}

const PAGE = keysetCursor('startsAt', 'asc');

const windowPassed = () =>
  appError.conflict(
    ErrorCode.BOOKING_WINDOW_PASSED,
    'The booking’s time has passed',
  );

/**
 * Bookings on the staff's side (ADR 0044), for whoever holds
 * `bookings.handle`: every booking of the compound with its unit and its
 * booker by name, a facility's day, the approvals queue, approving,
 * rejecting and cancelling; and the sweep that cancels a pending booking
 * nobody approved before its start.
 *
 * Locks, as every bookings write: the actor's account, the unit's advisory
 * lock, the facility's row, the booking's row. An approval takes the
 * facility's row FOR UPDATE: approvals of a facility go one at a time and
 * no booking of it is being decided meanwhile, so what is confirmed never
 * exceeds the capacity as it is now — after a cut too, and whatever the
 * slots' grid was when the bookings were made.
 */
@Injectable()
export class StaffBookingsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
    private readonly community: CommunityFacilitiesPort,
    private readonly access: FacilitiesAccess,
    private readonly facilities: FacilitiesService,
    private readonly bookings: BookingsService,
    private readonly notices: BookingNotices,
    private readonly suspensions: SuspensionsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(BOOKING_EXPIRE_SWEEP, (now) => this.expire(now), {
      intervalMs: 60_000,
    });
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** Every booking matching the filters, soonest first. */
  list(q: StaffBookingsQuery): Promise<Page<StaffBooking>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.booking.findMany({
        where: {
          AND: [
            {
              status: q.status,
              facilityId: q.facilityId,
              ...(q.from || q.to
                ? { startsAt: { gte: q.from, lt: q.to } }
                : {}),
            },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.named(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<StaffBooking> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id } });
      if (!booking) throw bookingNotFound();
      return (await this.named(tx, [booking]))[0];
    });
  }

  /**
   * A facility's local day: its slots with how much of each is taken, and
   * every booking of the day, whatever its status, by unit and booker.
   */
  day(facilityId: string, date?: LocalDate): Promise<FacilityDay> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const facility = await this.facilities.lock(tx, facilityId, 'share');
      const rules = rulesOf(facility);
      if (!rules)
        throw appError.conflict(
          ErrorCode.FACILITY_NOT_BOOKABLE,
          'A walk-in facility takes no booking',
        );
      const cal = await this.bookings.calendar(tx, facility, rules);
      const on = date ?? localDate(await dbNow(tx), cal.timeZone);
      const from = zonedInstant(on, 0, cal.timeZone)!;
      const to = zonedInstant(addDays(on, 1), 0, cal.timeZone)!;
      const rows = await tx.booking.findMany({
        where: { facilityId, startsAt: { lt: to }, endsAt: { gt: from } },
        orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const holding = rows.filter((b) =>
        (HOLDING as readonly string[]).includes(b.status),
      );
      return {
        date: on,
        rules,
        slots: slotsOfDate(on, cal).map((slot) => ({
          ...slot,
          taken: BookingsService.taken(rules, slot, holding),
        })),
        bookings: await this.named(tx, rows),
      };
    });
  }

  /** Unit codes and bookers' names for a staff view. */
  private async named(
    tx: TenantTxClient,
    rows: readonly Booking[],
  ): Promise<StaffBooking[]> {
    const codes = await this.community.unitCodes(
      tx,
      rows.map((b) => b.unitId),
    );
    const people = await this.community.accounts(
      tx,
      rows.map((b) => b.bookedById),
    );
    return rows.map((booking) => ({
      booking,
      unitCode: codes.get(booking.unitId) ?? '',
      bookedBy: people.get(booking.bookedById) ?? {
        id: booking.bookedById,
        fullName: null,
        erased: true,
      },
    }));
  }

  // --------------------------------------------------------------------------
  // Decisions
  // --------------------------------------------------------------------------

  /**
   * A pending booking becomes confirmed, before its start, if the slot's
   * confirmed bookings leave room for it under the capacity as it is now.
   */
  approve(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await this.seen(tx, id);
      await this.access.lockUnit(tx, seen.unitId);
      const facility = await this.facilities.lock(
        tx,
        seen.facilityId,
        'update',
      );
      const booking = await this.bookings.lockBooking(tx, id);
      assertCan(booking, 'approve');
      const now = await dbNow(tx);
      if (booking.startsAt.getTime() <= now.getTime()) throw windowPassed();
      const rules = rulesOf(facility)!;
      const confirmed = (
        await this.bookings.holdingBetween(
          tx,
          facility.id,
          booking.startsAt,
          booking.endsAt,
        )
      ).filter((b) => b.status === 'confirmed' && b.id !== id);
      const need = rules.capacityUnit === 'people' ? booking.partySize : 1;
      if (
        BookingsService.taken(rules, booking, confirmed) + need >
        rules.capacity
      )
        throw appError.conflict(
          ErrorCode.BOOKING_SLOT_FULL,
          'The slot has no room left for this booking',
        );
      await tx.booking.update({
        where: { id },
        data: {
          status: 'confirmed',
          decidedById: this.ctx.accountId,
          decidedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'booking.approved',
        targetId: id,
        metadata: { facilityId: booking.facilityId, unitId: booking.unitId },
      });
      await this.notices.send(
        tx,
        [booking.bookedById],
        'booking.approved',
        id,
        {},
        this.ctx.accountId,
      );
    });
  }

  /** A pending booking is not approved, before its start, with a reason code. */
  reject(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.bookingReject,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const booking = await this.lockForStaff(tx, id);
      assertCan(booking, 'reject');
      const now = await dbNow(tx);
      if (booking.startsAt.getTime() <= now.getTime()) throw windowPassed();
      await tx.booking.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectReason: reason,
          decidedById: this.ctx.accountId,
          decidedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'booking.rejected',
        targetId: id,
        metadata: {
          facilityId: booking.facilityId,
          unitId: booking.unitId,
          reasonCode: reason,
        },
      });
      await this.notices.send(
        tx,
        [booking.bookedById],
        'booking.rejected',
        id,
        { reason },
        this.ctx.accountId,
      );
    });
  }

  /**
   * The staff cancel a pending or confirmed booking before it ends, with a
   * reason code; whatever the facility's cutoff.
   */
  cancel(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.bookingStaffCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const booking = await this.lockForStaff(tx, id);
      assertCan(booking, 'cancel');
      const now = await dbNow(tx);
      if (booking.endsAt.getTime() <= now.getTime()) throw windowPassed();
      await this.cancelByStaffInTx(tx, booking, reason, now);
    });
  }

  /**
   * The staff's cancellation of a booking the caller has locked and judged
   * cancellable, in its transaction: ended by the caller with `reason`, and
   * its booker told. A facility ban (ADR 0067) cancels the account's
   * bookings here, with `facility_ban` and the ban they point at.
   */
  async cancelByStaffInTx(
    tx: TenantTxClient,
    booking: Booking,
    reason: string,
    now: Date,
    banId?: string,
  ): Promise<void> {
    await this.bookings.end(tx, booking, {
      side: 'staff',
      reason,
      by: this.ctx.accountId,
      now,
      banId,
    });
    await this.notices.send(
      tx,
      [booking.bookedById],
      'booking.cancelled_by_staff',
      booking.id,
      { reason },
      this.ctx.accountId,
    );
  }

  /**
   * Nobody came: a confirmed booking is marked a no-show after its slot
   * ended, within three days. Final. Under the unit's lock, the unit's
   * no-shows may then start its suspension.
   */
  markNoShow(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const booking = await this.lockForStaff(tx, id);
      assertCan(booking, 'mark_no_show');
      const now = await dbNow(tx);
      if (booking.endsAt.getTime() > now.getTime())
        throw appError.conflict(
          ErrorCode.BOOKING_NOT_OVER,
          'The booking’s slot has not ended',
        );
      if (now.getTime() - booking.endsAt.getTime() > NO_SHOW_HOURS * HOUR)
        throw appError.conflict(
          ErrorCode.BOOKING_NO_SHOW_TOO_LATE,
          'Too late to mark this booking a no-show',
          { params: { hours: NO_SHOW_HOURS } },
        );
      const marked = await tx.booking.update({
        where: { id },
        data: {
          status: 'no_show',
          noShowMarkedById: this.ctx.accountId,
          noShowMarkedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'booking.no_show',
        targetId: id,
        metadata: { facilityId: booking.facilityId, unitId: booking.unitId },
      });
      await this.suspensions.afterNoShow(tx, marked, now);
    });
  }

  /** The actor, the unit, the facility (shared), then the booking, locked. */
  private async lockForStaff(tx: TenantTxClient, id: string): Promise<Booking> {
    await this.access.lockSelf(tx);
    const seen = await this.seen(tx, id);
    await this.access.lockUnit(tx, seen.unitId);
    await this.facilities.lock(tx, seen.facilityId, 'share');
    return this.bookings.lockBooking(tx, id);
  }

  private async seen(tx: TenantTxClient, id: string): Promise<Booking> {
    const booking = await tx.booking.findUnique({ where: { id } });
    if (!booking) throw bookingNotFound();
    return booking;
  }

  // --------------------------------------------------------------------------
  // The sweep
  // --------------------------------------------------------------------------

  /**
   * Pending bookings whose start has passed with nobody's decision are
   * cancelled by the system (`approval_expired`) and their booker told. One
   * booking per transaction, judged again under the same locks as an
   * approval: an approval that won stays. Compounds that are not active
   * wait.
   */
  expire(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        if (!(await this.active(tx, tenantId))) return [];
        const due = await tx.booking.findMany({
          where: { status: 'pending', startsAt: { lte: now } },
          select: { id: true, unitId: true, facilityId: true },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        return due;
      },
      async (tx, _tenantId, due) => {
        await this.access.lockUnit(tx, due.unitId);
        await this.facilities.lock(tx, due.facilityId, 'share');
        const booking = await this.bookings.lockBooking(tx, due.id);
        if (
          booking.status !== 'pending' ||
          booking.startsAt.getTime() > now.getTime()
        )
          return 0;
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: 'cancelled',
            cancelledSide: 'system',
            cancelReason: 'approval_expired',
            cancelledAt: now,
          },
        });
        await this.audit.record(tx, {
          action: 'booking.expired',
          targetId: booking.id,
          metadata: {
            facilityId: booking.facilityId,
            unitId: booking.unitId,
            reasonCode: 'approval_expired',
          },
        });
        await this.notices.send(
          tx,
          [booking.bookedById],
          'booking.approval_expired',
          booking.id,
        );
        return 1;
      },
    );
  }

  private async active(tx: TenantTxClient, tenantId: string): Promise<boolean> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return tenant?.status === 'active';
  }
}
