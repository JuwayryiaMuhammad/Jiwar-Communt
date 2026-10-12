import {
  officeHoursProblems,
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
});
