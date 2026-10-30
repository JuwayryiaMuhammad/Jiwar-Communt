import { Injectable } from '@nestjs/common';
import type { Facility } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { toCsv, type CsvColumn } from '../../core/common/csv';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  addDays,
  localDate,
  zonedInstant,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { BookingsService } from '../bookings/bookings.service';
import { slotsOfDate } from '../bookings/facility-slots';
import { closuresBetween } from '../closures/closure-reads';
import { dbNow } from '../db-clock';
import { rulesOf } from '../setup/facility-rules';
import {
  BOOKING_STATUSES,
  daysOf,
  usageOf,
  usagePeriod,
  type Usage,
  type UsagePeriod,
} from './usage-rules';

export interface FacilityUsage {
  facility: Facility;
  usage: Usage;
}

export interface UsageReport {
  period: UsagePeriod;
  facilities: FacilityUsage[];
}

const COLUMNS: CsvColumn[] = [
  { header: 'facility', kind: 'text' },
  ...BOOKING_STATUSES.map((s) => ({ header: s, kind: 'number' as const })),
  { header: 'open_minutes', kind: 'number' },
  { header: 'booked_minutes', kind: 'number' },
  { header: 'use_percent', kind: 'number' },
  { header: 'no_show_percent', kind: 'number' },
  { header: 'peak_percent', kind: 'number' },
];

const text = (n: number | null) => (n === null ? null : String(n));

/**
 * How the bookable facilities are used over a period (ADR 0067), computed
 * on read for `facilities.manage` or `bookings.handle`: bookings by status
 * (by the day they start), slot use — booked time over the time its hours
 * offered, minus closures in force, times its capacity — no-shows and the
 * share at peak times. Nothing names a person.
 */
@Injectable()
export class FacilityUsageService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly tenantSettings: TenantSettingsService,
    private readonly bookings: BookingsService,
  ) {}

  report(q: { from?: LocalDate; to?: LocalDate }): Promise<UsageReport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timezone } = await this.tenantSettings.inTx(
        tx,
        this.ctx.tenantId,
      );
      const period = usagePeriod(q, localDate(await dbNow(tx), timezone));
      if (Array.isArray(period))
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid period',
          { fields: period },
        );
      const fromAt = zonedInstant(period.from, 0, timezone)!;
      const toAt = zonedInstant(addDays(period.to, 1), 0, timezone)!;
      const facilities = await tx.facility.findMany({
        where: { mode: 'bookable' },
        orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
      });
      const out: FacilityUsage[] = [];
      for (const facility of facilities) {
        const rules = rulesOf(facility)!;
        const cal = await this.bookings.calendar(tx, facility, rules);
        const slots = daysOf(period).flatMap((d) => slotsOfDate(d, cal));
        const closures = await closuresBetween(tx, facility.id, fromAt, toAt);
        const bookings = await tx.booking.findMany({
          where: {
            facilityId: facility.id,
            startsAt: { gte: fromAt, lt: toAt },
          },
          select: {
            startsAt: true,
            endsAt: true,
            status: true,
            partySize: true,
            peak: true,
          },
        });
        out.push({
          facility,
          usage: usageOf(rules, slots, closures, bookings),
        });
      }
      return { period, facilities: out };
    });
  }

  /** The same, one row per facility, as CSV. */
  async csv(q: { from?: LocalDate; to?: LocalDate }): Promise<Buffer> {
    const { facilities } = await this.report(q);
    return toCsv(
      COLUMNS,
      facilities.map(({ facility, usage: u }) => [
        facility.nameEn,
        ...BOOKING_STATUSES.map((s) => String(u.bookings[s])),
        String(u.openMinutes),
        String(Math.round(u.bookedMinutes)),
        text(u.use),
        text(u.noShowRate),
        text(u.peakShare),
      ]),
    );
  }
}
