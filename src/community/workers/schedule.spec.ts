import type { FieldError } from '../../core/common/errors';
import {
  checkSchedule,
  schedulesOverlap,
  type WorkerSchedule,
} from './schedule';

const s = (days: number[], ...windows: [string, string][]): WorkerSchedule => ({
  days,
  windows: windows.map(([from, to]) => ({ from, to })),
});

describe('worker schedules', () => {
  it.each([
    [
      'same day, overlapping hours',
      s([1], ['08:00', '12:00']),
      s([1], ['11:00', '15:00']),
      true,
    ],
    [
      'same day, touching hours',
      s([1], ['08:00', '12:00']),
      s([1], ['12:00', '15:00']),
      false,
    ],
    [
      'different days',
      s([1, 3], ['08:00', '12:00']),
      s([2, 4], ['08:00', '12:00']),
      false,
    ],
    [
      'one shared day of several',
      s([0, 5], ['09:00', '10:00']),
      s([5], ['09:30', '09:45']),
      true,
    ],
    ['live-in against anything', s([]), s([6], ['01:00', '02:00']), true],
  ])('%s', (_label, a, b, expected) => {
    expect(schedulesOverlap(a, b)).toBe(expected);
    expect(schedulesOverlap(b, a)).toBe(expected);
  });

  it('live-in schedules are empty; others need days and windows', () => {
    const fields: FieldError[] = [];
    expect(checkSchedule('live_in', undefined, fields)).toEqual(s([]));
    checkSchedule('live_in', s([1], ['08:00', '09:00']), fields);
    checkSchedule('hourly', s([], ['08:00', '09:00']), fields);
    checkSchedule('hourly', s([7], ['08:00', '09:00']), fields);
    checkSchedule('driver', s([1], ['09:00', '08:00']), fields);
    checkSchedule('nanny', s([1], ['24:00', '25:00']), fields);
    expect(fields.map((f) => f.field)).toEqual([
      'schedule',
      'schedule.days',
      'schedule.days',
      'schedule.windows',
      'schedule.windows',
    ]);
    expect(
      checkSchedule(
        'hourly',
        s([3, 1, 3], ['13:00', '17:00'], ['08:00', '12:00']),
        [],
      ),
    ).toEqual(s([1, 3], ['08:00', '12:00'], ['13:00', '17:00']));
  });
});
