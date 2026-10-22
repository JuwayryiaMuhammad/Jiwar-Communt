import { addDays, weekdayOf, zonedInstant } from './day-slots';
import {
  openAt,
  openLateTonight,
  sortedWindows,
  uncoveredWindows,
  weeklySlotsOfDay,
  weeklyWindowProblems,
  windowCode,
} from './weekly-windows';

const w = (weekday: number, startMinute: number, endMinute: number) => ({
  weekday,
  startMinute,
  endMinute,
});

describe('weekly windows', () => {
  it('a window ends after it starts and never overlaps an earlier one of its day; touching is fine', () => {
    expect(
      weeklyWindowProblems([w(1, 540, 720), w(1, 720, 1020), w(2, 540, 1020)]),
    ).toEqual([]);
    expect(
      weeklyWindowProblems([w(1, 540, 720), w(1, 700, 800), w(3, 600, 600)]),
    ).toEqual([
      { index: 1, problem: 'overlaps', other: 0 },
      { index: 2, problem: 'ends_before_start' },
    ]);
  });

  it('an inner window is covered when the outer windows of its weekday reach over it, touching ones as one', () => {
    const hours = [w(1, 360, 720), w(1, 720, 1320), w(2, 360, 600)];
    expect(
      uncoveredWindows(
        [
          w(1, 660, 780), // across the touch: covered
          w(1, 360, 1320), // the whole day: covered
          w(1, 300, 400), // starts before the hours
          w(1, 1300, 1380), // ends after them
          w(2, 540, 660), // runs past the day's only window
          w(3, 600, 660), // a day with no hours
        ],
        hours,
      ),
    ).toEqual([2, 3, 4, 5]);
    expect(uncoveredWindows([], hours)).toEqual([]);
    // A gap between two windows of a day leaves what spans it uncovered.
    expect(
      uncoveredWindows([w(1, 700, 800)], [w(1, 360, 720), w(1, 760, 900)]),
    ).toEqual([0]);
  });

  it('sorted by weekday then start, recorded as codes', () => {
    const sorted = sortedWindows([
      w(2, 60, 120),
      w(1, 600, 660),
      w(1, 60, 120),
    ]);
    expect(sorted.map(windowCode)).toEqual([
      '1:60-120',
      '1:600-660',
      '2:60-120',
    ]);
  });

  it('a day’s slots are its weekday’s windows, each cut, in order', () => {
    // 2031-01-13 is a Monday; Cairo is UTC+2 in winter.
    const slots = weeklySlotsOfDay(
      '2031-01-13',
      [w(1, 600, 720), w(1, 480, 540), w(2, 480, 540)],
      60,
      'Africa/Cairo',
    );
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2031-01-13T06:00:00.000Z',
      '2031-01-13T08:00:00.000Z',
      '2031-01-13T09:00:00.000Z',
    ]);
  });

  describe('open now and open late tonight (ADR 0060)', () => {
    const ZONE = 'Africa/Cairo';
    // 2031-01-13 is a Monday (weekday 1); Cairo is UTC+2 in winter.
    const at = (date: string, minute: number) =>
      zonedInstant(date, minute, ZONE)!;
    const office = [w(1, 540, 1020)];
    const pharmacy = [0, 1, 2, 3, 4, 5, 6].map((d) => w(d, 0, 1440));
    const lateBar = [w(1, 1080, 1440), w(2, 0, 120)];

    it('a window holds its start and not its end', () => {
      expect(openAt(office, at('2031-01-13', 540), ZONE)).toBe(true);
      expect(openAt(office, at('2031-01-13', 1019), ZONE)).toBe(true);
      expect(openAt(office, at('2031-01-13', 1020), ZONE)).toBe(false);
      expect(openAt(office, at('2031-01-13', 539), ZONE)).toBe(false);
      // Another weekday at the same minute.
      expect(openAt(office, at('2031-01-14', 600), ZONE)).toBe(false);
      expect(openAt([], at('2031-01-13', 600), ZONE)).toBe(false);
    });

    it('open all day is open at midnight, and past midnight the next day’s window holds', () => {
      expect(openAt(pharmacy, at('2031-01-13', 0), ZONE)).toBe(true);
      expect(openAt(pharmacy, at('2031-01-13', 1439), ZONE)).toBe(true);
      expect(openAt(lateBar, at('2031-01-14', 60), ZONE)).toBe(true);
      expect(openAt(lateBar, at('2031-01-14', 120), ZONE)).toBe(false);
    });

    it('open late: a window of today still open after the late hour, or after now when later', () => {
      const late = 1320; // 22:00
      expect(openLateTonight(office, at('2031-01-13', 600), ZONE, late)).toBe(
        false,
      );
      expect(openLateTonight(lateBar, at('2031-01-13', 600), ZONE, late)).toBe(
        true,
      );
      expect(
        openLateTonight(pharmacy, at('2031-01-13', 1430), ZONE, late),
      ).toBe(true);
      // Closing exactly at the late hour is not late.
      expect(
        openLateTonight([w(1, 600, 1320)], at('2031-01-13', 600), ZONE, late),
      ).toBe(false);
      // Open from 22:00 to 23:00, asked at 23:00: nothing of it is ahead.
      expect(
        openLateTonight([w(1, 1320, 1380)], at('2031-01-13', 1380), ZONE, late),
      ).toBe(false);
      // Tuesday's after-midnight window is not Monday's night.
      expect(
        openLateTonight([w(2, 0, 120)], at('2031-01-13', 600), ZONE, late),
      ).toBe(false);
    });

    it('a clock change moves nothing: the local clock decides, around the night it changes', () => {
      // Find a night in 2031 when Cairo's offset changes (summer time
      // starts in spring), and ask at 23:30 local on that day and the next.
      let date = '2031-03-01';
      const offset = (d: string) =>
        at(d, 720).getTime() -
        Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 12);
      for (let i = 0; i < 366 && offset(addDays(date, 1)) === offset(date); i++)
        date = addDays(date, 1);
      expect(offset(addDays(date, 1))).not.toBe(offset(date));
      for (const d of [date, addDays(date, 1)]) {
        const wd = weekdayOf(d);
        const nightly = [w(wd, 1380, 1440)];
        expect(openAt(nightly, at(d, 1410), ZONE)).toBe(true);
        expect(openAt(nightly, at(d, 1370), ZONE)).toBe(false);
        expect(openLateTonight(nightly, at(d, 600), ZONE, 1320)).toBe(true);
      }
    });
  });
});
