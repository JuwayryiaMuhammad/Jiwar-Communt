import type { CompoundHoliday } from '@prisma/client';
import type { LocalDate } from '../common/slots/day-slots';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// The compound's holiday calendar (ADR 0084), as the domains read it
// ============================================================================
//
// One list of dated holidays per compound. A holiday that stops works is a
// day off of the permits (ADR 0049): a works or move day, a debris removal
// and the gate's entries are refused on it exactly as they were on a day
// off. Everything else is only flagged by a holiday — a booking's day, a
// plan's due date — never refused or moved. Reads run in the caller's
// tenant transaction (RLS).

/** A holiday as a flag on someone else's day. */
export interface HolidayFlag {
  id: string;
  day: LocalDate;
  nameEn: string;
  nameAr: string;
  stopsWorks: boolean;
}

/** The calendar keeps at most this many holidays from today on. */
export const MAX_UPCOMING_HOLIDAYS = 100;

/** A DATE column's value, as the local day it holds. */
export function dayOfColumn(d: Date): LocalDate {
  return d.toISOString().slice(0, 10);
}

/** A local day, as a DATE column takes it. */
export function columnOfDay(day: LocalDate): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function flagOf(h: CompoundHoliday): HolidayFlag {
  return {
    id: h.id,
    day: dayOfColumn(h.day),
    nameEn: h.nameEn,
    nameAr: h.nameAr,
    stopsWorks: h.stopsWorks,
  };
}

/**
 * The compound's calendar row, locked: `update` for a write to its
 * holidays, `share` for a decision that reads them (a permit request, after
 * permit_settings' row), so the two go one after the other.
 */
export async function lockCalendar(
  tx: TenantTxClient,
  tenantId: string,
  lock: 'share' | 'update',
): Promise<void> {
  if (lock === 'update')
    await tx.$queryRaw`
      SELECT tenant_id FROM holiday_calendars
       WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
  else
    await tx.$queryRaw`
      SELECT tenant_id FROM holiday_calendars
       WHERE tenant_id = ${tenantId}::uuid FOR SHARE`;
}

/**
 * The days works and moves stop on: every holiday that stops works,
 * ascending — what permit_settings.days_off was (ADR 0049).
 */
export async function worksDaysOff(tx: TenantTxClient): Promise<LocalDate[]> {
  const rows = await tx.compoundHoliday.findMany({
    where: { stopsWorks: true },
    orderBy: { day: 'asc' },
    select: { day: true },
  });
  return rows.map((r) => dayOfColumn(r.day));
}

/** The holidays from `from` to `to` (local days, both included), by day. */
export async function holidaysBetween(
  tx: TenantTxClient,
  from: LocalDate,
  to: LocalDate,
): Promise<HolidayFlag[]> {
  if (to < from) return [];
  const rows = await tx.compoundHoliday.findMany({
    where: { day: { gte: columnOfDay(from), lte: columnOfDay(to) } },
    orderBy: { day: 'asc' },
  });
  return rows.map(flagOf);
}

/** By day, for flagging many days at once. */
export function byDay(
  flags: readonly HolidayFlag[],
): Map<LocalDate, HolidayFlag> {
  return new Map(flags.map((f) => [f.day, f]));
}
