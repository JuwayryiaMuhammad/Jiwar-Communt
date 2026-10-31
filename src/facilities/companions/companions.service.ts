import { createHash, randomBytes } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Booking, BookingCompanion, Facility } from '@prisma/client';
import { CommunityFacilitiesPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FacilitiesAccess } from '../access';
import { banInForce, dayOf } from '../bans/ban-reads';
import { isHolding } from '../bookings/booking-rules';
import { bookingNotFound, BookingsService } from '../bookings/bookings.service';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';
import { rulesOf, type FacilityRules } from '../setup/facility-rules';
import { FacilitiesService } from '../setup/facilities.service';
import { SuspensionsService } from '../suspensions/suspensions.service';

export const COMPANION_RESOURCE = 'booking_companion';

const LIVE = ['invited', 'accepted'];

/** The audit action of each way a companion's place ends. */
const ENDED = {
  declined: 'booking_companion.declined',
  left: 'booking_companion.left',
  removed: 'booking_companion.removed',
} as const;

/** A companion with its booking and facility, as the companion sees it. */
export interface CompanionPlace {
  companion: BookingCompanion;
  booking: Booking;
  facility: Pick<Facility, 'id' | 'nameEn' | 'nameAr'>;
}

const companionNotFound = () =>
  appError.notFound(ErrorCode.COMPANION_NOT_FOUND, 'Companion not found');
const inviteInvalid = () =>
  appError.notFound(
    ErrorCode.BOOKING_INVITE_INVALID,
    'This invitation is unknown or has expired',
  );
const transition = (status: string) =>
  appError.conflict(
    ErrorCode.COMPANION_INVALID_TRANSITION,
    'The companion does not take this action now',
    { params: { status } },
  );

export const hashToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Booking companions (ADR 0070): the booker invites one of the household
 * (by member id; they accept or decline), or shares the booking's link,
 * which anyone of the compound may open until the start — seeing the
 * facility and the time, never the booker — and join by. A companion holds
 * a seat from the invite: the booking's `companions` counts those invited
 * or accepted, a slot counted in people takes them, and guests plus
 * companions stay within the facility's `max_guests`. Joining is refused to
 * the booker, to an account banned from the facility, and while the unit is
 * suspended. A companion may leave; the booker may remove one, with a
 * code; a declined, left or removed seat is freed (and offered on the
 * waitlist).
 *
 * Locks, as every booking write: the caller's account (FOR SHARE), the
 * booking's unit, the facility (FOR SHARE), the slot's row, the booking's
 * row (FOR UPDATE), then the companions' rows.
 */
@Injectable()
export class CompanionsService implements OnModuleInit {
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
    private readonly notices: BookingNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(COMPANION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.placeOf(
          tx,
          await tx.bookingCompanion.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // The booker
  // --------------------------------------------------------------------------

  /** The booker invites one of the unit's household who has an account. */
  invite(bookingId: string, memberId: string): Promise<CompanionPlace> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: COMPANION_RESOURCE, id });
      await this.access.lockSelf(tx);
      const seen = await this.ownBooking(tx, bookingId);
      const member = (await this.community.clubPeople(tx, seen.unitId)).find(
        (p) => p.kind === 'member' && p.id === memberId,
      );
      if (!member?.accountId)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid request',
          {
            fields: [
              { field: 'memberId', code: FieldErrorCode.PERSON_NOT_OF_UNIT },
            ],
          },
        );
      const { booking } = await this.seat(tx, seen, member.accountId);
      const companion = await tx.bookingCompanion.create({
        data: {
          id,
          tenantId: booking.tenantId,
          bookingId: booking.id,
          accountId: member.accountId,
          via: 'household',
          householdMemberId: memberId,
          status: 'invited',
        },
      });
      await this.audit.record(tx, {
        action: 'booking_companion.invited',
        targetId: id,
        metadata: { bookingId: booking.id, unitId: booking.unitId },
      });
      await this.notices.send(
        tx,
        [member.accountId],
        'booking.companion_invited',
        booking.id,
        {},
        this.ctx.accountId,
      );
      return this.placeOf(tx, companion);
    });
  }

  /**
   * A new share link: a random token shown once, its hash kept on the
   * booking; any link before stops working. Until the start.
   */
  shareLink(bookingId: string): Promise<{ token: string; expiresAt: Date }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await this.ownBooking(tx, bookingId);
      const booking = await this.bookings.lockBooking(tx, seen.id);
      await this.assertOpen(tx, booking);
      const token = randomBytes(24).toString('base64url');
      await tx.booking.update({
        where: { id: booking.id },
        data: { companionTokenHash: hashToken(token) },
      });
      await this.audit.record(tx, {
        action: 'booking.share_link_rotated',
        targetId: booking.id,
        metadata: { unitId: booking.unitId },
      });
      return { token, expiresAt: booking.startsAt };
    });
  }

  /** The booking's companions: its booker's, and its unit's primary's. */
  list(bookingId: string): Promise<BookingCompanion[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (
        !booking ||
        (booking.bookedById !== this.ctx.accountId &&
          !(await this.community.isPrimary(
            tx,
            this.ctx.accountId,
            booking.unitId,
          )))
      )
        throw bookingNotFound();
      return tx.bookingCompanion.findMany({
        where: { bookingId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });
  }

  /** The booker removes a companion, invited or accepted, with a code. */
  remove(
    bookingId: string,
    companionId: string,
    reasonCode: string | undefined,
  ): Promise<BookingCompanion> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.companionRemove,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await this.ownBooking(tx, bookingId);
      const found = await tx.bookingCompanion.findUnique({
        where: { id: companionId },
      });
      if (!found || found.bookingId !== seen.id) throw companionNotFound();
      return this.end(tx, seen, companionId, 'removed', reason);
    });
  }

  // --------------------------------------------------------------------------
  // The companion
  // --------------------------------------------------------------------------

  /** What a link shows: the facility and the time, never the booker. */
  preview(token: string): Promise<{ booking: Booking; facility: Facility }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const booking = await this.byToken(tx, token);
      const facility = await tx.facility.findUniqueOrThrow({
        where: { id: booking.facilityId },
      });
      return { booking, facility };
    });
  }

  /** Anyone of the compound joins by the link: accepted at once. */
  join(token: string): Promise<CompanionPlace> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: COMPANION_RESOURCE, id });
      await this.access.lockSelf(tx);
      const seen = await this.byToken(tx, token);
      const { booking, now } = await this.seat(tx, seen, this.ctx.accountId);
      // The link may have been rotated while this waited for the locks.
      if (booking.companionTokenHash !== hashToken(token))
        throw inviteInvalid();
      const companion = await tx.bookingCompanion.create({
        data: {
          id,
          tenantId: booking.tenantId,
          bookingId: booking.id,
          accountId: this.ctx.accountId,
          via: 'link',
          status: 'accepted',
          respondedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'booking_companion.joined',
        targetId: id,
        metadata: { bookingId: booking.id, unitId: booking.unitId },
      });
      return this.placeOf(tx, companion);
    });
  }

  /** The caller's places with others' bookings, live first, soonest first. */
  mine(): Promise<CompanionPlace[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.bookingCompanion.findMany({
        where: { accountId: this.ctx.accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      const out: CompanionPlace[] = [];
      for (const r of rows) out.push(await this.placeOf(tx, r));
      return out.sort(
        (a, b) =>
          Number(LIVE.includes(b.companion.status)) -
            Number(LIVE.includes(a.companion.status)) ||
          a.booking.startsAt.getTime() - b.booking.startsAt.getTime(),
      );
    });
  }

  /**
   * For the caller's personal-data export (ADR 0036): every place they had
   * with another's booking, and every companion of the bookings they made —
   * the latter without who (the booking, the way in and the state).
   */
  everyOwn(): Promise<{
    places: CompanionPlace[];
    invited: BookingCompanion[];
  }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.bookingCompanion.findMany({
        where: { accountId: this.ctx.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const places: CompanionPlace[] = [];
      for (const r of rows) places.push(await this.placeOf(tx, r));
      const invited = await tx.bookingCompanion.findMany({
        where: { booking: { bookedById: this.ctx.accountId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return { places, invited };
    });
  }

  /** The invitee accepts: refused if banned from the facility now. */
  accept(companionId: string): Promise<CompanionPlace> {
    return this.answer(companionId, 'accepted');
  }

  /** The invitee declines: the seat is freed. */
  decline(companionId: string): Promise<CompanionPlace> {
    return this.answer(companionId, 'declined');
  }

  /** An accepted companion leaves: the seat is freed. */
  leave(bookingId: string): Promise<CompanionPlace> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await tx.bookingCompanion.findFirst({
        where: {
          bookingId,
          accountId: this.ctx.accountId,
          status: 'accepted',
        },
      });
      if (!found) throw companionNotFound();
      const seen = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
      });
      return this.placeOf(tx, await this.end(tx, seen, found.id, 'left'));
    });
  }

  private answer(
    companionId: string,
    to: 'accepted' | 'declined',
  ): Promise<CompanionPlace> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await tx.bookingCompanion.findUnique({
        where: { id: companionId },
      });
      if (!found || found.accountId !== this.ctx.accountId)
        throw companionNotFound();
      const seen = await tx.booking.findUniqueOrThrow({
        where: { id: found.bookingId },
      });
      if (to === 'declined')
        return this.placeOf(
          tx,
          await this.end(tx, seen, companionId, 'declined'),
        );
      const { booking, now } = await this.lockFor(tx, seen);
      await this.refuseBanned(tx, booking, this.ctx.accountId, now);
      const companion = await this.lockCompanion(tx, companionId);
      if (companion.status !== 'invited') throw transition(companion.status);
      const accepted = await tx.bookingCompanion.update({
        where: { id: companionId },
        data: { status: 'accepted', respondedAt: now },
      });
      await this.audit.record(tx, {
        action: 'booking_companion.accepted',
        targetId: companionId,
        metadata: { bookingId: booking.id, unitId: booking.unitId },
      });
      return this.placeOf(tx, accepted);
    });
  }

  // --------------------------------------------------------------------------
  // Seats
  // --------------------------------------------------------------------------

  /**
   * Under the locks, a seat for `accountId` on the booking: open, the joiner
   * not its booker, not banned from the facility, the unit not suspended,
   * not a companion already; guests and companions within `max_guests`, and
   * room in the slot when it counts people. Takes the seat.
   */
  private async seat(
    tx: TenantTxClient,
    seen: Booking,
    accountId: string,
  ): Promise<{ booking: Booking; now: Date }> {
    const { booking, facility, rules, now } = await this.lockFor(tx, seen);
    if (accountId === booking.bookedById)
      throw appError.conflict(
        ErrorCode.COMPANION_IS_BOOKER,
        'The booker comes with the booking already',
      );
    await this.refuseBanned(tx, booking, accountId, now);
    const suspended = await this.suspensions.current(tx, booking.unitId, now);
    if (suspended)
      throw appError.forbidden(
        ErrorCode.BOOKINGS_SUSPENDED,
        'The unit may not book for now',
        { params: { until: suspended.endsAt.toISOString() } },
      );
    const already = await tx.bookingCompanion.findFirst({
      where: { bookingId: booking.id, accountId, status: { in: LIVE } },
      select: { id: true },
    });
    if (already)
      throw appError.conflict(
        ErrorCode.COMPANION_EXISTS,
        'Already a companion of this booking',
        { params: { companionId: already.id } },
      );
    if (booking.guests + booking.companions + 1 > rules.maxGuests)
      throw appError.conflict(
        ErrorCode.BOOKING_PARTY_FULL,
        'The booking takes no more people',
        { params: { max: rules.maxGuests } },
      );
    if (rules.capacityUnit === 'people') {
      const taken = BookingsService.taken(
        rules,
        booking,
        await this.bookings.holdingBetween(
          tx,
          facility.id,
          booking.startsAt,
          booking.endsAt,
        ),
      );
      if (taken + 1 > rules.capacity)
        throw appError.conflict(
          ErrorCode.BOOKING_SLOT_FULL,
          'This slot is full',
        );
    }
    const updated = await tx.booking.update({
      where: { id: booking.id },
      data: { companions: { increment: 1 } },
    });
    return { booking: updated, now };
  }

  /**
   * Ends a live companion (declined, left or removed) and frees its seat,
   * under the locks.
   */
  private async end(
    tx: TenantTxClient,
    seen: Booking,
    companionId: string,
    to: 'declined' | 'left' | 'removed',
    reason?: string,
  ): Promise<BookingCompanion> {
    const { booking, now } = await this.lockFor(tx, seen, false);
    const companion = await this.lockCompanion(tx, companionId);
    const from =
      to === 'declined' ? ['invited'] : to === 'left' ? ['accepted'] : LIVE;
    if (!from.includes(companion.status)) throw transition(companion.status);
    const ended = await tx.bookingCompanion.update({
      where: { id: companionId },
      data: {
        status: to,
        endedAt: now,
        ...(to === 'declined' ? { respondedAt: now } : {}),
        ...(to === 'removed' ? { removeReason: reason } : {}),
      },
    });
    const freed = await tx.booking.update({
      where: { id: booking.id },
      data: { companions: { decrement: 1 } },
    });
    await this.audit.record(tx, {
      action: ENDED[to],
      targetId: companionId,
      metadata: {
        bookingId: booking.id,
        unitId: booking.unitId,
        ...(reason ? { reasonCode: reason } : {}),
      },
    });
    // The seat it frees goes to the waitlist (ADR 0070), under the slot's
    // row lock taken above.
    await this.bookings.offerFreed(tx, freed, now);
    return ended;
  }

  /**
   * The booking's unit, its facility (FOR SHARE), the slot's row and the
   * booking's row, in that order; the booking must be holding and not
   * started (`open`, for a seat taken; any holding one, for a seat freed).
   */
  private async lockFor(
    tx: TenantTxClient,
    seen: Booking,
    open = true,
  ): Promise<{
    booking: Booking;
    facility: Facility;
    rules: FacilityRules;
    now: Date;
  }> {
    await this.access.lockUnit(tx, seen.unitId);
    const facility = await this.facilities.lock(tx, seen.facilityId, 'share');
    const rules = rulesOf(facility);
    if (!rules)
      throw appError.conflict(
        ErrorCode.FACILITY_NOT_BOOKABLE,
        'Only a slot booking takes companions',
      );
    await this.bookings.lockSlotRow(tx, facility, seen.startsAt);
    const booking = await this.bookings.lockBooking(tx, seen.id);
    const now = await dbNow(tx);
    if (open) await this.assertOpen(tx, booking, now);
    return { booking, facility, rules, now };
  }

  private async assertOpen(
    tx: TenantTxClient,
    booking: Booking,
    now?: Date,
  ): Promise<void> {
    if (!isHolding(booking.status))
      throw appError.conflict(
        ErrorCode.BOOKING_INVALID_TRANSITION,
        'The booking does not take companions now',
        { params: { status: booking.status } },
      );
    if (booking.startsAt.getTime() <= (now ?? (await dbNow(tx))).getTime())
      throw appError.conflict(
        ErrorCode.BOOKING_WINDOW_PASSED,
        'The booking’s time has passed',
      );
  }

  private async refuseBanned(
    tx: TenantTxClient,
    booking: Booking,
    accountId: string,
    now: Date,
  ): Promise<void> {
    const zone = (await this.tenantSettings.inTx(tx, booking.tenantId))
      .timezone;
    const ban = await banInForce(
      tx,
      accountId,
      booking.facilityId,
      localDate(now, zone),
    );
    if (ban)
      throw appError.forbidden(
        ErrorCode.FACILITY_BANNED,
        'This person may not use this facility for now',
        {
          params: {
            ...(ban.facilityId ? { facilityId: ban.facilityId } : {}),
            ...(ban.endsOn ? { until: dayOf(ban.endsOn) } : {}),
          },
        },
      );
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** The caller's own booking (as its booker), or the one not-found. */
  private async ownBooking(tx: TenantTxClient, id: string): Promise<Booking> {
    const booking = await tx.booking.findUnique({ where: { id } });
    if (!booking || booking.bookedById !== this.ctx.accountId)
      throw bookingNotFound();
    return booking;
  }

  /** The booking a live link opens: holding and not started. */
  private async byToken(tx: TenantTxClient, token: string): Promise<Booking> {
    const booking = await tx.booking.findFirst({
      where: { companionTokenHash: hashToken(token) },
    });
    if (
      !booking ||
      !isHolding(booking.status) ||
      booking.startsAt.getTime() <= (await dbNow(tx)).getTime()
    )
      throw inviteInvalid();
    return booking;
  }

  private async lockCompanion(
    tx: TenantTxClient,
    id: string,
  ): Promise<BookingCompanion> {
    await tx.$queryRaw`
      SELECT id FROM booking_companions WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.bookingCompanion.findUniqueOrThrow({ where: { id } });
  }

  private async placeOf(
    tx: TenantTxClient,
    companion: BookingCompanion,
  ): Promise<CompanionPlace> {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: companion.bookingId },
    });
    const facility = await tx.facility.findUniqueOrThrow({
      where: { id: booking.facilityId },
      select: { id: true, nameEn: true, nameAr: true },
    });
    return { companion, booking, facility };
  }
}
