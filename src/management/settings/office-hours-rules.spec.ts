import { zonedInstant } from '../../core/common/slots/day-slots';
import {
  officeHoursProblems,
  officeStatus,
  sortedWindows,
  windowCode,
} from './office-hours-rules';

const w = (weekday: number, startMinute: number, endMinute: number) => ({
  weekday,
  startMinute,
  endMinute,
});

describe('office hours rules', () => {
  it('an empty set and a plain week are fine', () => {
    expect(officeHoursProblems([])).toEqual([]);
    expect(
      officeHoursProblems([0, 1, 2, 3, 4, 6].map((d) => w(d, 540, 1020))),
    ).toEqual([]);
  });

  it('windows of one day may touch, and the same hours on two days never clash', () => {
    expect(
      officeHoursProblems([w(1, 540, 720), w(1, 720, 1020), w(2, 540, 1020)]),
    ).toEqual([]);
  });

  it('a window ends after it starts', () => {
    expect(officeHoursProblems([w(1, 600, 600), w(2, 700, 600)])).toEqual([
      { index: 0, problem: 'ends_before_start' },
      { index: 1, problem: 'ends_before_start' },
    ]);
  });

  it.each([
    ['inside', w(1, 600, 660)],
    ['over the start', w(1, 500, 541)],
    ['over the end', w(1, 1019, 1100)],
    ['around', w(1, 0, 1440)],
    ['the same', w(1, 540, 1020)],
  ])('an overlap of the same weekday is named: %s', (_how, second) => {
    expect(officeHoursProblems([w(1, 540, 1020), second])).toEqual([
      { index: 1, problem: 'overlaps', other: 0 },
    ]);
  });

  it('a broken window is reported once and overlaps nothing', () => {
    expect(officeHoursProblems([w(1, 700, 600), w(1, 540, 1020)])).toEqual([
      { index: 0, problem: 'ends_before_start' },
    ]);
  });

  it('sorts by weekday then start, and codes a window as numbers', () => {
    expect(
      sortedWindows([w(6, 540, 600), w(0, 720, 900), w(0, 540, 600)]).map(
        windowCode,
      ),
    ).toEqual(['0:540-600', '0:720-900', '6:540-600']);
  });

  describe('the office now (ADR 0058)', () => {
    const zone = 'Africa/Cairo';
    // Saturday to Thursday, 09:00–17:00; 2026-10-22 is a Thursday.
    const week = [6, 0, 1, 2, 3, 4].map((d) => w(d, 540, 1020));
    const at = (date: string, minute: number) =>
      zonedInstant(date, minute, zone)!;

    it('open: until when, and when it opens next (Friday is off)', () => {
      expect(officeStatus(week, at('2026-10-22', 600), zone)).toEqual({
        openNow: true,
        closesAt: at('2026-10-22', 1020),
        nextOpensAt: at('2026-10-24', 540),
      });
    });

    it('closed: when it opens next', () => {
      expect(officeStatus(week, at('2026-10-22', 1080), zone)).toEqual({
        openNow: false,
        closesAt: null,
        nextOpensAt: at('2026-10-24', 540),
      });
      expect(officeStatus(week, at('2026-10-24', 480), zone)).toMatchObject({
        openNow: false,
        nextOpensAt: at('2026-10-24', 540),
      });
    });

    it('touching windows are one stretch; no windows, never open', () => {
      const split = [w(4, 540, 720), w(4, 720, 1020)];
      expect(officeStatus(split, at('2026-10-22', 660), zone)).toMatchObject({
        openNow: true,
        closesAt: at('2026-10-22', 1020),
      });
      expect(officeStatus([], at('2026-10-22', 600), zone)).toEqual({
        openNow: false,
        closesAt: null,
        nextOpensAt: null,
      });
    });
  });
});
