import { attendanceRange } from './attendance.service';

const CAIRO = 'Africa/Cairo';

/**
 * A worker's attendance (ADR 0028): by default the 30 days up to the
 * compound's today, by the database's clock, in its zone.
 */
describe('the attendance range by default', () => {
  it.each([
    // 2026-10-17 in Cairo (UTC+3), whatever the UTC date.
    ['00:30', '2026-10-16T21:30:00Z', '2026-09-18', '2026-10-17'],
    ['02:59', '2026-10-16T23:59:00Z', '2026-09-18', '2026-10-17'],
    ['23:50', '2026-10-17T20:50:00Z', '2026-09-18', '2026-10-17'],
    // Across 2026-10-29 (the clocks go back at 24:00 UTC+3).
    ['23:30 (UTC+2)', '2026-10-29T21:30:00Z', '2026-09-30', '2026-10-29'],
    ['00:30 (UTC+2)', '2026-10-29T22:30:00Z', '2026-10-01', '2026-10-30'],
  ])('%s in Cairo: %s to %s', (_, iso, from, to) => {
    expect(attendanceRange({}, new Date(iso), CAIRO)).toEqual({ from, to });
  });

  it('a given end counts 29 calendar days back; given days stay', () => {
    const now = new Date('2026-10-16T21:30:00Z');
    expect(attendanceRange({ to: '2026-11-10' }, now, CAIRO)).toEqual({
      from: '2026-10-12',
      to: '2026-11-10',
    });
    expect(
      attendanceRange({ from: '2026-10-01', to: '2026-10-05' }, now, CAIRO),
    ).toEqual({ from: '2026-10-01', to: '2026-10-05' });
  });
});
