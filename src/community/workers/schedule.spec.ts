import type { FieldError } from '../../core/common/errors';
import {
  checkSchedule,
  isWithinSchedule,
  schedulesOverlap,
  weeklyIntervals,
  type WorkerSchedule,
} from './schedule';

const s = (days: number[], ...windows: [string, string][]): WorkerSchedule => ({
  days,
  windows: windows.map(([from, to]) => ({ from, to })),
});

// 0 = Sunday … 4 = Thursday, 5 = Friday, 6 = Saturday.
describe('worker schedules', () => {
  describe('overlap on the weekly timeline', () => {
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
        'Thursday 22:00–06:00 vs Friday 05:00–07:00',
        s([4], ['22:00', '06:00']),
        s([5], ['05:00', '07:00']),
        true,
      ],
      [
        'Saturday 23:00–02:00 vs Sunday 01:00–01:30',
        s([6], ['23:00', '02:00']),
        s([0], ['01:00', '01:30']),
        true,
      ],
      [
        'overnight end 06:00 vs next-day start 06:00',
        s([4], ['22:00', '06:00']),
        s([5], ['06:00', '09:00']),
        false,
      ],
      [
        'overnight vs same evening before it starts',
        s([4], ['22:00', '06:00']),
        s([4], ['18:00', '22:00']),
        false,
      ],
      ['live-in against anything', s([]), s([6], ['01:00', '02:00']), true],
    ])('%s', (_label, a, b, expected) => {
      expect(schedulesOverlap(a, b)).toBe(expected);
      expect(schedulesOverlap(b, a)).toBe(expected);
    });

    it('a Saturday-night window wraps into Sunday morning', () => {
      expect(weeklyIntervals(s([6], ['23:00', '02:00']))).toEqual([
        [6 * 1440 + 23 * 60, 7 * 1440],
        [0, 120],
      ]);
    });
  });

  describe('isWithinSchedule (compound time zone)', () => {
    const tz = 'Africa/Cairo';
    // 2026-10-01 is a Thursday; Cairo is UTC+3 then (DST).
    const at = (iso: string) => new Date(iso);
    const nightShift = s([4], ['22:00', '06:00']); // Thursday night

    it.each([
      ['Thursday 23:30 Cairo', '2026-10-01T20:30:00Z', true],
      [
        'Friday 05:59 Cairo (the next calendar day)',
        '2026-10-02T02:59:00Z',
        true,
      ],
      [
        'Friday 06:00 Cairo (the end is exclusive)',
        '2026-10-02T03:00:00Z',
        false,
      ],
      ['Thursday 21:59 Cairo', '2026-10-01T18:59:00Z', false],
      [
        'Friday 23:00 Cairo (no window that night)',
        '2026-10-02T20:00:00Z',
        false,
      ],
    ])('%s → %s', (_label, iso, expected) => {
      expect(isWithinSchedule(nightShift, at(iso), tz)).toBe(expected);
    });

    it('reads the time in the given zone, not UTC', () => {
      const morning = s([4], ['08:00', '09:00']); // Thursday 08:00–09:00
      const instant = at('2026-10-01T05:30:00Z'); // 08:30 Cairo, 05:30 UTC
      expect(isWithinSchedule(morning, instant, 'Africa/Cairo')).toBe(true);
      expect(isWithinSchedule(morning, instant, 'UTC')).toBe(false);
    });

    it('live-in is always within', () => {
      expect(isWithinSchedule(s([]), at('2026-10-03T03:00:00Z'), tz)).toBe(
        true,
      );
    });
  });

  describe('validation', () => {
    it('live-in schedules are empty; others need days and windows; from == to is INVALID_SCHEDULE', () => {
      const fields: FieldError[] = [];
      expect(checkSchedule('live_in', undefined, fields)).toEqual(s([]));
      checkSchedule('live_in', s([1], ['08:00', '09:00']), fields);
      checkSchedule('hourly', s([], ['08:00', '09:00']), fields);
      checkSchedule('hourly', s([7], ['08:00', '09:00']), fields);
      checkSchedule('nanny', s([1], ['24:00', '25:00']), fields);
      checkSchedule('driver', s([1], ['09:00', '09:00']), fields);
      expect(fields.map((f) => `${f.field}:${f.code}`)).toEqual([
        'schedule:FIELD_NOT_ALLOWED',
        'schedule.days:INVALID_VALUE',
        'schedule.days:INVALID_VALUE',
        'schedule.windows:INVALID_FORMAT',
        'schedule.windows:INVALID_SCHEDULE',
      ]);
    });

    it('an overnight window is valid, and schedules are normalized', () => {
      const fields: FieldError[] = [];
      expect(
        checkSchedule('driver', s([1], ['22:00', '06:00']), fields),
      ).toEqual(s([1], ['22:00', '06:00']));
      expect(
        checkSchedule(
          'hourly',
          s([3, 1, 3], ['13:00', '17:00'], ['08:00', '12:00']),
          fields,
        ),
      ).toEqual(s([1, 3], ['08:00', '12:00'], ['13:00', '17:00']));
      expect(fields).toEqual([]);
    });
  });
});
