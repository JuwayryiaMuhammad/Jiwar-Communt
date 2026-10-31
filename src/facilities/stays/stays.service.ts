import { Injectable } from '@nestjs/common';
import { CommunityFacilitiesPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { Charges } from '../../core/charges/charges';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  addDays,
  localDate,
  zonedInstant,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FacilitiesAccess } from '../access';
import { banInForce, dayOf } from '../bans/ban-reads';
import { COUNTED, HOLDING } from '../bookings/booking-rules';
import {
  BOOKING_RESOURCE,
  BookingsService,
  charging,
  type BookingRead,
} from '../bookings/bookings.service';
import { WEEK_MS, withinQuota } from '../bookings/quota-window';
import { ClubService } from '../club/club.service';
import { closedOver } from '../closures/closure-reads';
import { dbNow } from '../db-clock';
import { stayRulesOf } from '../setup/facility-rules';
import {
  FacilitiesService,
  facilityNotFound,
} from '../setup/facilities.service';
import { SuspensionsService } from '../suspensions/suspensions.service';

export interface NewStay {
  facilityId: string;
  /** The first night, local. */
  fromOn: LocalDate;
  /** The check-out day, local: the day after the last night. */
  toOn: LocalDate;
  guests?: number;
}

const DAY_MS = 86_400_000;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/** The nights from `fromOn` to the night before `toOn`, ascending. */
export function nightsOf(fromOn: LocalDate, toOn: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = fromOn; d < toOn; d = addDays(d, 1)) out.push(d);
  return out;
}

/** An instant of a local day; a minute a clock change skips moves on an hour. */
const at = (on: LocalDate, minute: number, zone: string): Date =>
  zonedInstant(on, minute, zone) ?? zonedInstant(on, minute + 60, zone)!;

/**
 * Overnight guest rooms (ADR 0070): a stay facility is booked by the night,
 * confirmed at once. Its start and end are the check-in and check-out
 * instants in the compound's time zone. Under the locks: the caller may book
 * for the unit, it is not suspended, the booker is not banned; 1 to
 * `maxNights` nights, not too soon nor too far; not closed over; the unit's
 * weekly quota counts a stay as one booking; each night has a room. A stay
 * takes its nights' lock rows FOR UPDATE in ascending order, so two stays
 * that share nights never wait on each other in a cycle.
 *
 * Locks: the caller's account (FOR SHARE), the unit, the facility (FOR
 * SHARE), the unit's finance lock when it charges, the club's membership
 * (FOR SHARE), then the nights.
 */
@Injectable()
export class StaysService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly community: CommunityFacilitiesPort,
    private readonly access: FacilitiesAccess,
    private readonly facilities: FacilitiesService,
    private readonly bookings: BookingsService,
    private readonly suspensions: SuspensionsService,
    private readonly club: ClubService,
    private readonly charges: Charges,
  ) {}

  book(unitId: string, input: NewStay): Promise<BookingRead> {
    const guests = input.guests ?? 0;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: BOOKING_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.access.lockUnit(tx, unitId);
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (!caps.bookings)
        throw appError.forbidden(
          ErrorCode.BOOKINGS_NOT_ALLOWED,
          'This person may not book for this unit',
        );
      const now = await dbNow(tx);
      const suspended = await this.suspensions.current(tx, unitId, now);
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
      if (!facility.active) throw facilityNotFound();
      const rules = stayRulesOf(facility);
      if (!rules)
        throw appError.conflict(
          ErrorCode.FACILITY_NOT_BOOKABLE,
          'Only a stay facility is booked by the night',
        );
      if (charging(facility)) await this.charges.lockUnit(tx, unitId);
      const zone = (await this.tenantSettings.inTx(tx, facility.tenantId))
        .timezone;
      const today = localDate(now, zone);
      const ban = await banInForce(tx, this.ctx.accountId, facility.id, today);
      if (ban)
        throw appError.forbidden(
          ErrorCode.FACILITY_BANNED,
          'This person may not book this facility for now',
          {
            params: {
              ...(ban.facilityId ? { facilityId: ban.facilityId } : {}),
              ...(ban.endsOn ? { until: dayOf(ban.endsOn) } : {}),
            },
          },
        );
      const fields: FieldError[] = [];
      if (guests > rules.maxGuests)
        fields.push({
          field: 'guests',
          code: FieldErrorCode.BOOKING_TOO_MANY_GUESTS,
          params: { max: rules.maxGuests },
        });
      const nights = nightsOf(input.fromOn, input.toOn);
      if (!nights.length)
        fields.push({ field: 'toOn', code: FieldErrorCode.ENDS_BEFORE_START });
      else if (nights.length > rules.maxNights)
        fields.push({
          field: 'toOn',
          code: FieldErrorCode.STAY_TOO_LONG,
          params: { max: rules.maxNights },
        });
      const startsAt = at(input.fromOn, rules.checkInMinute, zone);
      const endsAt = at(input.toOn, rules.checkOutMinute, zone);
      if (startsAt.getTime() - now.getTime() < rules.minMinutesBefore * 60_000)
        fields.push({
          field: 'fromOn',
          code: FieldErrorCode.BOOKING_TOO_SOON,
          params: { minutes: rules.minMinutesBefore },
        });
      else if (input.fromOn > addDays(today, rules.maxDaysAhead))
        fields.push({
          field: 'fromOn',
          code: FieldErrorCode.BOOKING_TOO_FAR,
          params: { days: rules.maxDaysAhead },
        });
      if (fields.length) throw invalid(fields);
      if (
        rules.requiresMembership &&
        !(await this.club.covers(tx, unitId, this.ctx.accountId, input.fromOn))
      )
        throw appError.forbidden(
          ErrorCode.CLUB_MEMBERSHIP_REQUIRED,
          'This facility is for club members',
        );
      if (await closedOver(tx, facility.id, { startsAt, endsAt }))
        throw appError.conflict(
          ErrorCode.FACILITY_CLOSED,
          'The facility is closed at that time',
        );
      await this.checkQuota(
        tx,
        unitId,
        facility.id,
        startsAt,
        endsAt,
        rules.weeklyQuota,
      );

      // The nights, ascending: a night is full at `rooms` stays covering it.
      for (const night of nights) {
        await tx.$executeRaw`
          INSERT INTO facility_night_locks (tenant_id, facility_id, night_on)
          VALUES (${facility.tenantId}::uuid, ${facility.id}::uuid, ${night}::date)
          ON CONFLICT DO NOTHING`;
        await tx.$queryRaw`
          SELECT night_on FROM facility_night_locks
           WHERE tenant_id = ${facility.tenantId}::uuid
             AND facility_id = ${facility.id}::uuid
             AND night_on = ${night}::date FOR UPDATE`;
      }
      for (const night of nights) {
        const covering = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM bookings
           WHERE facility_id = ${facility.id}::uuid
             AND status::text = ANY(${[...HOLDING]}::text[])
             AND stay_from_on <= ${night}::date AND stay_to_on > ${night}::date`;
        if (Number(covering[0].n) >= rules.rooms)
          throw appError.conflict(
            ErrorCode.STAY_NIGHT_FULL,
            'No room is free that night',
            { params: { nightOn: night } },
          );
      }

      const booking = await tx.booking.create({
        data: {
          id,
          tenantId: facility.tenantId,
          facilityId: facility.id,
          unitId,
          bookedById: this.ctx.accountId,
          startsAt,
          endsAt,
          guests,
          partySize: guests + 1,
          peak: false,
          status: 'confirmed',
          stayFromOn: new Date(`${input.fromOn}T00:00:00.000Z`),
          stayToOn: new Date(`${input.toOn}T00:00:00.000Z`),
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'booking.created',
        targetId: booking.id,
        metadata: {
          facilityId: facility.id,
          unitId,
          status: 'confirmed',
          peak: false,
          guests,
          startsAt: startsAt.toISOString(),
          stay: { fromOn: input.fromOn, toOn: input.toOn },
        },
      });
      await this.bookings.raiseFee(tx, facility, booking, zone, nights.length);
      return this.bookings.readIn(tx, booking);
    });
  }

  /** A stay counts as one booking of the unit's weekly quota; one at a time. */
  private async checkQuota(
    tx: TenantTxClient,
    unitId: string,
    facilityId: string,
    startsAt: Date,
    endsAt: Date,
    quota: number,
  ): Promise<void> {
    const around = await tx.booking.findMany({
      where: {
        unitId,
        facilityId,
        status: { in: [...COUNTED] },
        startsAt: {
          gt: new Date(startsAt.getTime() - WEEK_MS - 14 * DAY_MS),
          lt: new Date(startsAt.getTime() + WEEK_MS),
        },
      },
      select: { startsAt: true, endsAt: true, status: true },
    });
    if (
      around.some(
        (b) =>
          (HOLDING as readonly string[]).includes(b.status) &&
          b.startsAt < endsAt &&
          b.endsAt > startsAt,
      )
    )
      throw appError.conflict(
        ErrorCode.BOOKING_ALREADY_HELD,
        'The unit already holds a stay over these nights',
      );
    if (
      !withinQuota(
        around.map((b) => b.startsAt),
        startsAt,
        quota,
      )
    )
      throw appError.conflict(
        ErrorCode.BOOKING_QUOTA_REACHED,
        'The unit has as many stays here as a week allows',
        { params: { quota, peak: false } },
      );
  }
}
