import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BookingWaitlistEntry } from '@prisma/client';
import { CommunityFacilitiesPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FacilitiesAccess } from '../access';
import { banInForce, dayOf } from '../bans/ban-reads';
import {
  BookingsService,
  type BookingRead,
} from '../bookings/bookings.service';
import { bookableWhen, slotAt } from '../bookings/facility-slots';
import { closedOver } from '../closures/closure-reads';
import { dbNow } from '../db-clock';
import { rulesOf } from '../setup/facility-rules';
import {
  FacilitiesService,
  facilityNotFound,
} from '../setup/facilities.service';
import { SuspensionsService } from '../suspensions/suspensions.service';
import {
  needOf,
  WAITLIST_LAST_MINUTES,
  WaitlistOffers,
} from './waitlist-offers';

export const WAITLIST_RESOURCE = 'booking_waitlist_entry';
export const WAITLIST_SWEEP = 'facilities.waitlist';
/** An account waits for at most this many slots at once. */
export const WAITLIST_MAX = 3;
const MINUTE = 60_000;
const LIVE = ['waiting', 'offered'];

export interface NewWaitlistEntry {
  unitId: string;
  startsAt: Date;
  guests?: number;
}

const entryNotFound = () =>
  appError.notFound(
    ErrorCode.WAITLIST_ENTRY_NOT_FOUND,
    'Waitlist entry not found',
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/**
 * The booking waitlist (ADR 0070): a resident who books for a unit waits
 * for a full slot — refused while it has room (BOOKING_SLOT_AVAILABLE) —
 * at most three slots at once, one entry per slot. What frees room is
 * offered in the order of joining (WaitlistOffers); an offer holds its
 * place for the compound's hold, then the sweep lapses it and offers the
 * next. Claimed, the offer is the entry's booking through book(), which
 * frees only its own hold. A stay takes no waitlist.
 *
 * Locks, as every booking write: the caller's account (FOR SHARE), the
 * unit, the facility (FOR SHARE), the slot's row; entries change only under
 * their slot's row lock.
 */
@Injectable()
export class WaitlistService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
    private readonly tenantSettings: TenantSettingsService,
    private readonly community: CommunityFacilitiesPort,
    private readonly access: FacilitiesAccess,
    private readonly facilities: FacilitiesService,
    private readonly bookings: BookingsService,
    private readonly suspensions: SuspensionsService,
    private readonly offers: WaitlistOffers,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(WAITLIST_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) =>
        tx.bookingWaitlistEntry.findUniqueOrThrow({ where: { id } }),
      ),
    );
    this.sweep.register(WAITLIST_SWEEP, (now) => this.lapseDue(now), {
      intervalMs: 60_000,
    });
  }

  /** Waits for a full slot of the facility, for the unit. */
  join(
    facilityId: string,
    input: NewWaitlistEntry,
  ): Promise<BookingWaitlistEntry> {
    const guests = input.guests ?? 0;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: WAITLIST_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.access.lockUnit(tx, input.unitId);
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        input.unitId,
      );
      if (!caps)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (!caps.bookings)
        throw appError.forbidden(
          ErrorCode.BOOKINGS_NOT_ALLOWED,
          'This person may not book for this unit',
        );
      const now = await dbNow(tx);
      const suspended = await this.suspensions.current(tx, input.unitId, now);
      if (suspended)
        throw appError.forbidden(
          ErrorCode.BOOKINGS_SUSPENDED,
          'The unit may not book for now',
          { params: { until: suspended.endsAt.toISOString() } },
        );
      const facility = await this.facilities.lock(tx, facilityId, 'share');
      if (!facility.active) throw facilityNotFound();
      const rules = rulesOf(facility);
      if (!rules)
        throw appError.conflict(
          ErrorCode.FACILITY_NOT_BOOKABLE,
          'Only a slot booking takes a waitlist',
        );
      const zone = (await this.tenantSettings.inTx(tx, facility.tenantId))
        .timezone;
      const ban = await banInForce(
        tx,
        this.ctx.accountId,
        facility.id,
        localDate(now, zone),
      );
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
      if (guests > rules.maxGuests)
        throw invalid([
          {
            field: 'guests',
            code: FieldErrorCode.BOOKING_TOO_MANY_GUESTS,
            params: { max: rules.maxGuests },
          },
        ]);
      const cal = await this.bookings.calendar(tx, facility, rules);
      const slot = slotAt(input.startsAt, cal);
      if (!slot)
        throw invalid([
          { field: 'startsAt', code: FieldErrorCode.BOOKING_SLOT_NOT_OFFERED },
        ]);
      const when = bookableWhen(slot, now, rules, cal.timeZone);
      const latest = slot.startsAt.getTime() - WAITLIST_LAST_MINUTES * MINUTE;
      if (when === 'too_soon' || latest <= now.getTime())
        throw invalid([
          {
            field: 'startsAt',
            code: FieldErrorCode.BOOKING_TOO_SOON,
            params: {
              minutes: Math.max(rules.minMinutesBefore, WAITLIST_LAST_MINUTES),
            },
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

      await this.bookings.lockSlotRow(tx, facility, slot.startsAt);
      const mine = await tx.bookingWaitlistEntry.findMany({
        where: { accountId: this.ctx.accountId, status: { in: LIVE } },
        select: { id: true, facilityId: true, startsAt: true },
      });
      const same = mine.find(
        (e) =>
          e.facilityId === facility.id &&
          e.startsAt.getTime() === slot.startsAt.getTime(),
      );
      if (same)
        throw appError.conflict(
          ErrorCode.WAITLIST_EXISTS,
          'Already waiting for this slot',
          { params: { entryId: same.id } },
        );
      if (mine.length >= WAITLIST_MAX)
        throw appError.conflict(
          ErrorCode.WAITLIST_LIMIT_REACHED,
          'Waiting for as many slots as allowed',
          { params: { max: WAITLIST_MAX } },
        );
      const party = guests + 1;
      const taken =
        BookingsService.taken(
          rules,
          slot,
          await this.bookings.holdingBetween(
            tx,
            facility.id,
            slot.startsAt,
            slot.endsAt,
          ),
        ) + (await this.offers.offerSeats(tx, facility, slot.startsAt, now));
      if (taken + needOf(rules, { partySize: party }) <= rules.capacity)
        throw appError.conflict(
          ErrorCode.BOOKING_SLOT_AVAILABLE,
          'The slot has room: book it',
        );
      const entry = await tx.bookingWaitlistEntry.create({
        data: {
          id,
          tenantId: facility.tenantId,
          facilityId: facility.id,
          startsAt: slot.startsAt,
          accountId: this.ctx.accountId,
          unitId: input.unitId,
          partySize: party,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'booking_waitlist.joined',
        targetId: id,
        metadata: {
          facilityId: facility.id,
          unitId: input.unitId,
          startsAt: slot.startsAt.toISOString(),
          guests,
        },
      });
      return entry;
    });
  }

  /** The caller leaves a slot's waitlist: an offer it held goes to the next. */
  leave(id: string): Promise<BookingWaitlistEntry> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await this.own(tx, id);
      await this.access.lockUnit(tx, seen.unitId);
      const facility = await this.facilities.lock(tx, seen.facilityId, 'share');
      await this.bookings.lockSlotRow(tx, facility, seen.startsAt);
      const entry = await tx.bookingWaitlistEntry.findUniqueOrThrow({
        where: { id },
      });
      if (!LIVE.includes(entry.status))
        throw appError.conflict(
          ErrorCode.WAITLIST_ENTRY_ENDED,
          'The entry has ended',
          { params: { status: entry.status } },
        );
      const now = await dbNow(tx);
      const left = await tx.bookingWaitlistEntry.update({
        where: { id },
        data: { status: 'left', endedAt: now },
      });
      await this.audit.record(tx, {
        action: 'booking_waitlist.left',
        targetId: id,
        metadata: { facilityId: entry.facilityId, from: entry.status },
      });
      if (entry.status === 'offered')
        await this.offers.offerFreedInTx(tx, facility, entry.startsAt, now);
      return left;
    });
  }

  /** The offer becomes the entry's booking, as book() decides any. */
  async claim(id: string): Promise<BookingRead> {
    const entry = await this.tenantTx.withTenantTx((tx) => this.own(tx, id));
    return this.bookings.book(entry.unitId, {
      facilityId: entry.facilityId,
      startsAt: entry.startsAt,
      guests: entry.partySize - 1,
      fromEntryId: entry.id,
    });
  }

  /** Every entry the caller made, oldest first: their personal-data export. */
  everyOwn(): Promise<BookingWaitlistEntry[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.bookingWaitlistEntry.findMany({
        where: { accountId: this.ctx.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  /** The caller's entries, newest first; at most 50. */
  mine(): Promise<BookingWaitlistEntry[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.bookingWaitlistEntry.findMany({
        where: { accountId: this.ctx.accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    );
  }

  /**
   * The sweep: an offer whose hold ended lapses and the slot's next entry is
   * offered; entries of a slot too close to its start lapse. One slot per
   * transaction, under its row lock.
   */
  lapseDue(now: Date): Promise<number> {
    const latest = new Date(now.getTime() + WAITLIST_LAST_MINUTES * MINUTE);
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const due = await tx.bookingWaitlistEntry.findMany({
          where: {
            OR: [
              { status: 'offered', offerExpiresAt: { lte: now } },
              { status: 'waiting', startsAt: { lte: latest } },
            ],
          },
          select: { facilityId: true, startsAt: true },
          distinct: ['facilityId', 'startsAt'],
          take: 200,
        });
        return due;
      },
      async (tx, _tenantId, slot) => {
        const facility = await this.facilities.lock(
          tx,
          slot.facilityId,
          'share',
        );
        await this.bookings.lockSlotRow(tx, facility, slot.startsAt);
        const expired = await tx.bookingWaitlistEntry.findMany({
          where: {
            facilityId: slot.facilityId,
            startsAt: slot.startsAt,
            status: 'offered',
            offerExpiresAt: { lte: now },
          },
        });
        for (const e of expired) await this.offers.lapse(tx, e, now);
        await this.offers.offerFreedInTx(tx, facility, slot.startsAt, now);
        return expired.length;
      },
    );
  }

  private async own(
    tx: TenantTxClient,
    id: string,
  ): Promise<BookingWaitlistEntry> {
    const entry = await tx.bookingWaitlistEntry.findUnique({ where: { id } });
    if (!entry || entry.accountId !== this.ctx.accountId) throw entryNotFound();
    return entry;
  }
}
