import { Injectable } from '@nestjs/common';
import type { BookingWaitlistEntry, Facility } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { HOLDING } from '../bookings/booking-rules';
import { heldIn } from '../bookings/facility-slots';
import { BookingNotices } from '../notices/booking-notices';
import { rulesOf, type FacilityRules } from '../setup/facility-rules';
import { FacilitySettingsService } from '../settings/facility-settings.service';

const MINUTE = 60_000;
/** An offer never holds past this many minutes before the start; closer, entries lapse. */
export const WAITLIST_LAST_MINUTES = 15;

/** What an entry takes of its slot: its party, or one booking. */
export const needOf = (
  rules: Pick<FacilityRules, 'capacityUnit'>,
  e: Pick<BookingWaitlistEntry, 'partySize'>,
) => (rules.capacityUnit === 'people' ? e.partySize : 1);

/**
 * The waitlist's offers (ADR 0070), for every path that frees room in a
 * slot and for book(): no dependency on the bookings' service, which
 * calls it. Entries change only under their slot's row lock, which every
 * caller holds; so the order of offers is the order of joining, and a
 * place is never offered twice.
 */
@Injectable()
export class WaitlistOffers {
  constructor(
    private readonly audit: AuditService,
    private readonly notices: BookingNotices,
    private readonly settings: FacilitySettingsService,
  ) {}

  /** The live offers of a slot: offered and not expired, but `except`. */
  async liveOffers(
    tx: TenantTxClient,
    facilityId: string,
    startsAt: Date,
    now: Date,
    except?: string,
  ): Promise<BookingWaitlistEntry[]> {
    return tx.bookingWaitlistEntry.findMany({
      where: {
        facilityId,
        startsAt,
        status: 'offered',
        offerExpiresAt: { gt: now },
        ...(except ? { id: { not: except } } : {}),
      },
    });
  }

  /** What the slot's live offers take, as its capacity counts. */
  async offerSeats(
    tx: TenantTxClient,
    facility: Facility,
    startsAt: Date,
    now: Date,
    except?: string,
  ): Promise<number> {
    const rules = rulesOf(facility);
    if (!rules) return 0;
    return (
      await this.liveOffers(tx, facility.id, startsAt, now, except)
    ).reduce((sum, e) => sum + needOf(rules, e), 0);
  }

  /**
   * Offers the room a slot has now to its waiting entries, in the order they
   * joined, one by one while each fits; past the last offer time, the
   * waiting entries lapse instead. Under the slot's row lock the caller
   * holds. Returns how many were offered.
   */
  async offerFreedInTx(
    tx: TenantTxClient,
    facility: Facility,
    startsAt: Date,
    now: Date,
  ): Promise<number> {
    const rules = rulesOf(facility);
    if (!rules) return 0;
    const endsAt = new Date(startsAt.getTime() + rules.slotMinutes * MINUTE);
    const waiting = await tx.bookingWaitlistEntry.findMany({
      where: { facilityId: facility.id, startsAt, status: 'waiting' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!waiting.length) return 0;
    const latest = new Date(
      startsAt.getTime() - WAITLIST_LAST_MINUTES * MINUTE,
    );
    if (latest.getTime() <= now.getTime()) {
      for (const e of waiting) await this.lapse(tx, e, now);
      return 0;
    }
    const holding = await tx.booking.findMany({
      where: {
        facilityId: facility.id,
        status: { in: [...HOLDING] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });
    const inSlot = heldIn({ startsAt, endsAt }, holding);
    const taken =
      rules.capacityUnit === 'people'
        ? inSlot.reduce((sum, b) => sum + b.partySize + b.companions, 0)
        : inSlot.length;
    let free =
      rules.capacity -
      taken -
      (await this.offerSeats(tx, facility, startsAt, now));
    const hold = (await this.settings.inTx(tx)).waitlistHoldMinutes;
    const expires = new Date(
      Math.min(now.getTime() + hold * MINUTE, latest.getTime()),
    );
    let offered = 0;
    for (const e of waiting) {
      const need = needOf(rules, e);
      // First come, first offered: one that does not fit stops the line.
      if (need > free) break;
      await tx.bookingWaitlistEntry.update({
        where: { id: e.id },
        data: { status: 'offered', offeredAt: now, offerExpiresAt: expires },
      });
      await this.audit.record(tx, {
        action: 'booking_waitlist.offered',
        targetId: e.id,
        metadata: {
          facilityId: facility.id,
          startsAt: startsAt.toISOString(),
          offerExpiresAt: expires.toISOString(),
        },
      });
      await this.notices.send(
        tx,
        [e.accountId],
        'booking_waitlist.offered',
        e.id,
      );
      free -= need;
      offered++;
    }
    return offered;
  }

  /** An entry ends unbooked: its offer expired, or its slot is too close. */
  async lapse(
    tx: TenantTxClient,
    e: BookingWaitlistEntry,
    now: Date,
  ): Promise<void> {
    await tx.bookingWaitlistEntry.update({
      where: { id: e.id },
      data: { status: 'lapsed', endedAt: now },
    });
    await this.audit.record(tx, {
      action: 'booking_waitlist.lapsed',
      targetId: e.id,
      metadata: { facilityId: e.facilityId, from: e.status },
    });
  }

  /**
   * A closure over the facility closes the live entries of the slots it
   * covers that have not started, and tells their accounts. Under the
   * facility's row, held FOR UPDATE by the closure.
   */
  async closeIn(
    tx: TenantTxClient,
    facility: Facility,
    from: Date,
    to: Date,
    now: Date,
  ): Promise<number> {
    const rules = rulesOf(facility);
    if (!rules) return 0;
    // A slot the closure overlaps: it starts before the end and ends after
    // the start.
    const earliest = new Date(from.getTime() - rules.slotMinutes * MINUTE);
    const live = await tx.bookingWaitlistEntry.findMany({
      where: {
        facilityId: facility.id,
        status: { in: ['waiting', 'offered'] },
        startsAt: { gt: earliest, lt: to },
      },
    });
    for (const e of live) {
      await tx.bookingWaitlistEntry.update({
        where: { id: e.id },
        data: { status: 'closed', endedAt: now },
      });
      await this.notices.send(
        tx,
        [e.accountId],
        'booking_waitlist.closed',
        e.id,
      );
    }
    return live.length;
  }
}
