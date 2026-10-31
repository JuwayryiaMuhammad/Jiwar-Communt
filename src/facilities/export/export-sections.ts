import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityFacilitiesPort } from '../../community';
import { AppException } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { BookingsService } from '../bookings/bookings.service';
import { BookingView } from '../bookings/views/booking.views';
import { FacilityBansService } from '../bans/bans.service';
import { dayOf } from '../bans/ban-reads';
import { ClubService } from '../club/club.service';
import { ClubPaymentView } from '../club/views/club.views';
import { ClubRequestsService } from '../club/club-requests.service';
import { ClubRequestView } from '../club/views/club-request.views';
import { CompanionsService } from '../companions/companions.service';
import { CompanionBookingView } from '../companions/views/companion.views';

/**
 * The facilities section of a personal-data export (ADR 0044). It runs as
 * the account and reads through the account's own services and views:
 *
 * - `facilities/bookings.json`: every booking it made, whatever the unit;
 * - `facilities/bans.json`: every ban from booking it was given (ADR 0067),
 *   with its scope, reason, last day and state — never who gave it;
 * - `facilities/club/<unitCode>.json`: for each unit it has a place in now
 *   and whose household it sees, the membership's state, the last day it
 *   is active, and since when it covers the account (or not); its payments
 *   only where the account sees the unit's money;
 * - `facilities/club-requests.json`: every club membership request it made
 *   (ADR 0070), with its plan, price, state and invoice;
 * - `facilities/companions.json`: the places it had with others' bookings
 *   (the facility, the time, its state — never the booker), and the
 *   companions of the bookings it made (the booking, the way in and the
 *   state — never who).
 *
 * Nothing here names another person: not who else a membership covers,
 * nor who else of the household booked.
 */
@Injectable()
export class FacilitiesExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityFacilitiesPort,
    private readonly bookings: BookingsService,
    private readonly club: ClubService,
    private readonly bans: FacilityBansService,
    private readonly clubRequests: ClubRequestsService,
    private readonly companions: CompanionsService,
  ) {}

  onModuleInit(): void {
    this.sections.register('facilities', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    yield {
      path: 'facilities/bookings.json',
      json: (await this.bookings.mine()).map((b) =>
        BookingView.from(b, s.accountId),
      ),
    };
    yield {
      path: 'facilities/bans.json',
      json: (await this.bans.everyOwn()).map(({ ban: b, state }) => ({
        id: b.id,
        facilityId: b.facilityId,
        reasonCode: b.reasonCode,
        endsOn: b.endsOn ? dayOf(b.endsOn) : null,
        state,
        startedAt: b.createdAt,
        liftedAt: b.liftedAt,
      })),
    };
    yield {
      path: 'facilities/club-requests.json',
      json: (await this.clubRequests.everyOwn()).map((r) =>
        ClubRequestView.from(r),
      ),
    };
    const companions = await this.companions.everyOwn();
    yield {
      path: 'facilities/companions.json',
      json: {
        places: companions.places.map((p) => CompanionBookingView.fromPlace(p)),
        invited: companions.invited.map((c) => ({
          id: c.id,
          bookingId: c.bookingId,
          via: c.via,
          status: c.status,
          createdAt: c.createdAt,
          endedAt: c.endedAt,
        })),
      },
    };
    const units = await this.tenantTx.withTenantTx((tx) =>
      this.community.places(tx, s.accountId),
    );
    const codes = await this.tenantTx.withTenantTx((tx) =>
      this.community.unitCodes(tx, units),
    );
    for (const unitId of units) {
      let read: Awaited<ReturnType<ClubService['forUnit']>>;
      try {
        read = await this.club.forUnit(unitId);
      } catch (e) {
        // Not the account's to see (a landlord sees no household).
        if (e instanceof AppException) continue;
        throw e;
      }
      if (!read.file) continue;
      const me = read.file.people.find((p) => p.accountId === s.accountId);
      yield {
        path: `facilities/club/${codes.get(unitId) ?? unitId}.json`,
        json: {
          unitId,
          state: read.file.state,
          activeThrough: read.file.activeThrough,
          coversMeSince: me?.coveredSince ?? null,
          payments: read.payments
            ? ClubPaymentView.list(read.file.records)
            : null,
        },
      };
    }
  }
}
