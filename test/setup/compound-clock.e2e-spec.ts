import {
  isTimeZone,
  TenantSettingsService,
} from '../../src/core/tenant-settings/tenant-settings.service';
import { communityHelpers } from './community';
import { withinHours, workDaysOf } from './permits';
import {
  aroundTheClock,
  clock,
  clockAt,
  compoundClock,
  dbDate,
  localDay,
  localMinute,
  midnightWait,
  middayZone,
  month,
  ofDbDate,
  yearsBefore,
  ZONE,
} from './compound-clock';
import { createHttpHarness, type HttpHarness } from './http-app';

const MINUTE = 60_000;

/**
 * The compound's clock for tests (test/setup/compound-clock.ts): Cairo's
 * calendar at the hours a UTC runner gets it wrong, calendar days across
 * a clock change, the minutes around midnight no suite starts in, and a
 * compound in a zone of its own.
 */
describe('The compound clock (tests)', () => {
  const cairo = (iso: string) => clockAt(new Date(iso), ZONE);

  // 2026-10-17, Cairo on summer time (UTC+3); the clocks go back on the
  // night of 2026-10-29.
  it.each([
    ['00:30', '2026-10-16T21:30:00Z', 30],
    ['02:59', '2026-10-16T23:59:00Z', 179],
    ['22:30', '2026-10-17T19:30:00Z', 1350],
    ['23:50', '2026-10-17T20:50:00Z', 1430],
  ])('%s in Cairo: Cairo’s day, whatever the UTC date', (_, iso, minute) => {
    const c = cairo(iso);
    expect(c.today).toBe('2026-10-17');
    expect(c.minute).toBe(minute);
    expect(localDay(c.now)).toBe('2026-10-17');
    expect(localMinute(c.now)).toBe(minute);
    expect(c.day(-1)).toBe('2026-10-16');
    expect(c.day(0)).toBe('2026-10-17');
    expect(c.day(1)).toBe('2026-10-18');
    // Calendar days across 2026-10-29, never n × 24 hours.
    expect(c.day(12)).toBe('2026-10-29');
    expect(c.day(13)).toBe('2026-10-30');
    expect(c.day(31)).toBe('2026-11-17');
    expect(c.day(90)).toBe('2027-01-15');
    expect(c.day(91)).toBe('2027-01-16');
    expect(c.month()).toBe('2026-10');
    expect(c.month(3)).toBe('2027-01');
    expect(c.month(-10)).toBe('2025-12');
    expect(c.weekday()).toBe(6); // a Saturday
    // A wall-clock time of a day, in Cairo's offset of that day.
    expect(c.at(c.today, 18).toISOString()).toBe('2026-10-17T15:00:00.000Z');
    expect(c.at(c.day(90), 18).toISOString()).toBe('2027-01-15T16:00:00.000Z');
  });

  it('00:30 in Cairo in winter (UTC+2), 22:30 UTC the day before', () => {
    const c = cairo('2026-12-15T22:30:00Z');
    expect(c.today).toBe('2026-12-16');
    expect(c.day(-1)).toBe('2026-12-15');
    expect(c.day(31)).toBe('2027-01-16');
  });

  it('the clock changes: the hour repeated in autumn, the hour skipped in spring', () => {
    // 2026-10-29 24:00 (UTC+3) is 23:00 (UTC+2): 23:30 happens twice; the
    // first one is taken.
    const autumn = cairo('2026-10-29T20:30:00Z');
    expect(autumn.at('2026-10-29', 23, 30).toISOString()).toBe(
      '2026-10-29T20:30:00.000Z',
    );
    expect(cairo('2026-10-29T21:30:00Z').today).toBe('2026-10-29');
    expect(cairo('2026-10-29T22:30:00Z').today).toBe('2026-10-30');
    expect(autumn.at('2026-10-30', 0, 30).toISOString()).toBe(
      '2026-10-29T22:30:00.000Z',
    );
    // 2027-04-30 00:00 (UTC+2) is 01:00 (UTC+3): 00:30 does not exist.
    const spring = cairo('2027-04-29T21:30:00Z');
    expect(spring.today).toBe('2027-04-29');
    expect(spring.day(1)).toBe('2027-04-30');
    expect(() => spring.at('2027-04-30', 0, 30)).toThrow('does not exist');
    expect(spring.at('2027-04-30', 1).toISOString()).toBe(
      '2027-04-29T22:00:00.000Z',
    );
  });

  it('no suite starts in the six minutes before Cairo’s midnight or the two after', () => {
    const wait = (iso: string) => midnightWait(new Date(iso));
    expect(wait('2026-10-17T19:30:00Z')).toBe(0); // 22:30
    expect(wait('2026-10-17T20:53:59Z')).toBe(0); // 23:53:59
    // 23:54:00 → 00:02:01; 23:59:30 → 00:02:01; 00:01:00 → 00:02:01.
    expect(wait('2026-10-17T20:54:00Z')).toBe(8 * MINUTE + 1_000);
    expect(wait('2026-10-17T20:59:30Z')).toBe(2.5 * MINUTE + 1_000);
    expect(wait('2026-10-17T21:01:00Z')).toBe(MINUTE + 1_000);
    expect(wait('2026-10-17T21:02:00Z')).toBe(0); // 00:02
    // Winter: Cairo's midnight is 22:00 UTC.
    expect(wait('2026-12-15T21:59:00Z')).toBe(3 * MINUTE + 1_000);
    expect(wait('2026-12-15T21:30:00Z')).toBe(0);
  });

  it.each([
    '2026-10-16T21:30:00Z',
    '2026-10-16T23:59:00Z',
    '2026-10-17T19:30:00Z',
    '2026-10-17T20:50:00Z',
    '2026-12-15T22:30:00Z',
  ])('at %s some zone the server takes is at midday', (iso) => {
    const now = new Date(iso);
    const zone = middayZone(now);
    expect(isTimeZone(zone)).toBe(true);
    const c = clockAt(now, zone);
    expect(c.minute).toBeGreaterThanOrEqual(600);
    expect(c.minute).toBeLessThan(840);
    // Five hours later is still the same day there.
    expect(localDay(new Date(now.getTime() + 5 * 60 * MINUTE), zone)).toBe(
      c.today,
    );
  });

  // Sunday 2026-10-18, 09:10 in Cairo: the morning CI failed with day(5),
  // a Friday, as a move's date.
  const sunday = cairo('2026-10-18T06:10:00Z');
  const provisioned = {
    workDays: [0, 1, 2, 3, 4, 6],
    workHours: { from: '09:00', to: '17:00' },
    daysOff: [] as string[],
    timeZone: ZONE,
  };

  it('a work day is asked of the compound’s rules, never a fixed offset', () => {
    expect(sunday.weekday()).toBe(0);
    expect(sunday.day(5)).toBe('2026-10-23'); // a Friday: the failure
    expect(workDaysOf(provisioned, 1, 5, sunday)).toEqual(['2026-10-24']);
    expect(workDaysOf(provisioned, 3, 3, sunday)).toEqual([
      '2026-10-21',
      '2026-10-22',
      '2026-10-24',
    ]);
    // Its days off too, and only its week days.
    const narrow = {
      ...provisioned,
      workDays: [3],
      daysOff: ['2026-10-21'],
    };
    expect(workDaysOf(narrow, 2, 1, sunday)).toEqual([
      '2026-10-28',
      '2026-11-04',
    ]);
    expect(() =>
      workDaysOf({ ...provisioned, workDays: [] }, 1, 1, sunday),
    ).toThrow('No 1 work days');
  });

  it('a window inside the compound’s hours, or its first two', () => {
    const hours = (from: string, to: string) => ({
      ...provisioned,
      workHours: { from, to },
    });
    const wanted = { from: '10:00', to: '12:00' };
    expect(withinHours(hours('09:00', '17:00'), wanted)).toEqual(wanted);
    expect(withinHours(hours('13:00', '20:00'), wanted)).toEqual({
      from: '13:00',
      to: '15:00',
    });
    expect(withinHours(hours('16:00', '17:00'), wanted)).toEqual({
      from: '16:00',
      to: '17:00',
    });
  });

  it.each([
    ['00:30', '2026-10-16T21:30:00Z', '12:30', '12:29'],
    ['12:00', '2026-10-17T09:00:00Z', '00:00', '23:59'],
    ['23:50', '2026-10-17T20:50:00Z', '11:50', '11:49'],
  ])(
    'around the clock at %s: the one minute left out is twelve hours away',
    (_, iso, from, to) => {
      expect(aroundTheClock(cairo(iso))).toEqual({
        days: [0, 1, 2, 3, 4, 5, 6],
        windows: [{ from, to }],
      });
    },
  );

  it('days of `@db.Date` columns and of birth dates', () => {
    expect(dbDate('2026-10-17').toISOString()).toBe('2026-10-17T00:00:00.000Z');
    expect(ofDbDate(dbDate('2026-10-17'))).toBe('2026-10-17');
    expect(yearsBefore('2026-10-17', 18)).toBe('2008-10-17');
    expect(yearsBefore('2026-10-17', 18, -2)).toBe('2008-10-19');
    expect(yearsBefore('2028-02-29', 1)).toBe('2027-03-01');
  });

  describe('a compound’s own zone, by the database’s clock', () => {
    let h: HttpHarness;
    let x: ReturnType<typeof communityHelpers>;

    beforeAll(async () => {
      h = await createHttpHarness();
      x = communityHelpers(h);
    }, 60_000);

    afterAll(() => h.close());

    it('Cairo unless the compound says otherwise; its day where it is', async () => {
      const c = await x.compound('Clock Court');
      expect((await compoundClock(h, c.tenantId)).zone).toBe(ZONE);
      expect((await compoundClock(h, c.tenantId)).today).toBe(clock().today);
      const zone = middayZone();
      await x.asManager(c, () =>
        h.moduleRef.get(TenantSettingsService).update({ timezone: zone }),
      );
      const there = await compoundClock(h, c.tenantId);
      expect(there.zone).toBe(zone);
      expect(there.today).toBe(clock(zone).today);
      expect(there.minute).toBeGreaterThanOrEqual(600);
      expect(month()).toBe(clock().today.slice(0, 7));
    });
  });
});
