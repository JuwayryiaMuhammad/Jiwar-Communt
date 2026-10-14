import {
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
});
