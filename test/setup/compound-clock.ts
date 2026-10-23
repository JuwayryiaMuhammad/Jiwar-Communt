import {
  addDays,
  localParts,
  weekdayOf,
  zonedInstant,
  type LocalDate,
} from '../../src/core/common/slots/day-slots';
import type { TestingModule } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import type { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';

// ============================================================================
// The compound's clock, for tests
// ============================================================================
//
// The only place a test turns an instant into a compound's day, a time of
// day or a month (the lint rule in eslint.config.mjs refuses the UTC and
// local-time idioms everywhere else in test/). The server decides "today"
// as localDate(dbNow, tenant_settings.timezone); so does this: the database
// clock (the runner's, corrected by the skew measured when a harness
// starts), the compound's zone, and calendar arithmetic, never n × 24 h
// (a daylight-saving change in between would move the day).

export type { LocalDate };

/** tenant_settings.timezone's default: every compound's zone unless set. */
export const ZONE = 'Africa/Cairo';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let skewMs = 0;

/** The database's clock now, as the server's dbNow reads it. */
export function dbClock(): Date {
  return new Date(Date.now() + skewMs);
}

/**
 * Measures how far the database's clock is from the runner's (the harness
 * calls it once). On one host it is about zero; it keeps "today" the
 * server's even when the database runs elsewhere.
 */
export async function syncDbClock(db: GlobalDbService): Promise<void> {
  const before = Date.now();
  const [{ now }] = await db.transaction(
    (tx) => tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`,
  );
  skewMs = now.getTime() - (before + Date.now()) / 2;
}

/** A compound's calendar at one instant. */
export interface Clock {
  now: Date;
  zone: string;
  /** The local day of `now`. */
  today: LocalDate;
  /** Minutes after local midnight of `now`. */
  minute: number;
  /** `n` calendar days from today. */
  day(n: number): LocalDate;
  /** The instant a local day reads `hour:minute` (throws in a DST gap). */
  at(date: LocalDate, hour: number, minute?: number): Date;
  /** The local month `n` months from this one, `YYYY-MM`. */
  month(n?: number): string;
  /** 0 is Sunday; today's when no day is given. */
  weekday(date?: LocalDate): number;
}

/** The calendar of `zone` at `now`: pure, for any instant. */
export function clockAt(now: Date, zone: string = ZONE): Clock {
  const { date: today, minute } = localParts(now, zone);
  return {
    now,
    zone,
    today,
    minute,
    day: (n) => addDays(today, n),
    at: (date, hour, min = 0) => zonedAt(date, hour * 60 + min, zone),
    month: (n = 0) => addMonths(today.slice(0, 7), n),
    weekday: (date = today) => weekdayOf(date),
  };
}

/** The calendar of `zone` now, by the database's clock. */
export const clock = (zone: string = ZONE): Clock => clockAt(dbClock(), zone);

/**
 * A compound's calendar now, in its own zone (tenant_settings.timezone),
 * for a compound whose zone is not the default.
 */
export async function compoundClock(
  h: { moduleRef: TestingModule },
  tenantId: string,
): Promise<Clock> {
  const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
  const { timezone } = await cls.run(async () => {
    cls.set('tenantId', tenantId);
    return await h.moduleRef
      .get(TenantTx)
      .withTenantTx((tx) =>
        h.moduleRef.get(TenantSettingsService).inTx(tx, tenantId),
      );
  });
  return clock(timezone);
}

/** The compound's local day today (the default zone). */
export const today = (): LocalDate => clock().today;

/** The compound's local day `n` calendar days from today. */
export const day = (n: number): LocalDate => clock().day(n);

/** The instant a local day reads `hour:minute` in the compound. */
export const at = (date: LocalDate, hour: number, minute = 0): Date =>
  zonedAt(date, hour * 60 + minute, ZONE);

/** The compound's local month `n` months from this one, `YYYY-MM`. */
export const month = (n = 0): string => clock().month(n);

/**
 * The same local wall time `n` of the compound's calendar days after
 * `from` (the database's clock by default): "a week later" as the server
 * counts days, never n × 24 h, which a clock change in between turns into
 * a day more or less. A time the clock skips that day moves to the next
 * minute that exists.
 */
export function daysLater(
  n: number,
  from: Date = dbClock(),
  zone: string = ZONE,
): Date {
  const { date, minute } = localParts(from, zone);
  const target = addDays(date, n);
  for (let m = minute; m < 1440; m++) {
    const instant = zonedInstant(target, m, zone);
    if (instant) return new Date(instant.getTime() + (from.getTime() % MINUTE));
  }
  throw new Error(`No instant at or after ${hhmm(minute)} on ${target}`);
}

/** The local day of an instant. */
export const localDay = (instant: Date, zone: string = ZONE): LocalDate =>
  localParts(instant, zone).date;

/** Minutes after local midnight of an instant. */
export const localMinute = (instant: Date, zone: string = ZONE): number =>
  localParts(instant, zone).minute;

/** `HH:MM` of a minute of the day (wraps past midnight). */
export const hhmm = (minute: number): string => {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * A weekly schedule open every day but for one minute, twelve hours from
 * now (an overnight window): never the minute a test runs in.
 */
export function aroundTheClock(c: Clock = clock()): {
  days: number[];
  windows: { from: string; to: string }[];
} {
  const { minute } = c;
  return {
    days: [0, 1, 2, 3, 4, 5, 6],
    windows: [{ from: hhmm(minute + 720), to: hhmm(minute + 719) }],
  };
}

/** `YYYY-MM` plus `n` months. */
export function addMonths(yearMonth: string, n: number): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** `date` minus `years` calendar years and `days` days (29 Feb rolls on). */
export function yearsBefore(
  date: LocalDate,
  years: number,
  days = 0,
): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  return ofDbDate(new Date(Date.UTC(y - years, m - 1, d - days)));
}

/** An instant `months` calendar months after `from`, at the same UTC time. */
export function monthsAfter(from: Date, months: number): Date {
  const out = new Date(from);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/** A `@db.Date` value: Prisma writes and reads a day at UTC midnight. */
export const dbDate = (date: LocalDate): Date =>
  new Date(`${date}T00:00:00.000Z`);

/** The day a `@db.Date` value holds. */
export const ofDbDate = (value: Date): LocalDate =>
  value.toISOString().slice(0, 10);

/** A wall-clock time on a day with a fixed UTC offset, e.g. `+02:00`. */
export const wallClock = (date: LocalDate, time: string, offset: string) =>
  new Date(`${date}T${time}${offset}`);

function zonedAt(date: LocalDate, minute: number, zone: string): Date {
  const instant = zonedInstant(date, minute, zone);
  if (!instant)
    throw new Error(`${date} ${hhmm(minute)} does not exist in ${zone}`);
  return instant;
}

// ----------------------------------------------------------------------------
// Away from midnight
// ----------------------------------------------------------------------------

/**
 * How close to the default zone's midnight, in minutes, a suite may not
 * start: before it, longer than any suite runs (the longest, about two
 * and a half minutes); after it, a day's first minutes.
 */
export const MIDNIGHT_MARGIN = { before: 6, after: 2 } as const;

/**
 * How long to wait, in ms, before the clock is out of the minutes around
 * the zone's midnight (0 outside them). A suite reads "today" in its
 * set-up and its tests, and expects the server to agree until it ends.
 */
export function midnightWait(now: Date, zone: string = ZONE): number {
  const { minute } = localParts(now, zone);
  const from = 1440 - MIDNIGHT_MARGIN.before;
  if (minute < from && minute >= MIDNIGHT_MARGIN.after) return 0;
  const left =
    minute >= from
      ? 1440 - minute + MIDNIGHT_MARGIN.after
      : MIDNIGHT_MARGIN.after - minute;
  const intoMinute = now.getTime() % MINUTE;
  return left * MINUTE - intoMinute + 1_000;
}

// ----------------------------------------------------------------------------
// A zone where it is midday now
// ----------------------------------------------------------------------------

/**
 * A zone where the local time is between 10:00 and 14:00 now and no clock
 * change falls in the next 36 hours: a compound set to it keeps "in a few
 * hours" on today, whatever hour the test runs. For tests about the hours
 * of one day, never about Cairo's rules.
 */
export function middayZone(now: Date = dbClock()): string {
  const stable = (zone: string) =>
    offsetMinutes(now, zone) ===
    offsetMinutes(new Date(now.getTime() + 36 * HOUR), zone);
  const zone = Intl.supportedValuesOf('timeZone').find((z) => {
    const { minute } = localParts(now, z);
    return minute >= 600 && minute < 840 && stable(z);
  });
  if (!zone) throw new Error('No zone is at midday now');
  return zone;
}

function offsetMinutes(instant: Date, zone: string): number {
  const p = localParts(instant, zone);
  const local = Date.parse(`${p.date}T${hhmm(p.minute)}:00Z`);
  return Math.round(
    (local - Math.floor(instant.getTime() / MINUTE) * MINUTE) / MINUTE,
  );
}
