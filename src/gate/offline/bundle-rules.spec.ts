import {
  BUNDLE_MAX_MS,
  bundleValidUntil,
  OVERTIME_MS,
  SLOT_GRACE_MS,
  UNSCHEDULED_MS,
} from './bundle-rules';

// Instants written out, never read from a clock.
const T0 = new Date('2026-11-06T09:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;

describe('a bundle’s validity (ADR 0057)', () => {
  it('the slot’s planned end and its grace', () => {
    expect(bundleValidUntil(T0, plus(8 * HOUR))).toEqual(
      plus(8 * HOUR + SLOT_GRACE_MS),
    );
  });

  it('a day at most', () => {
    expect(bundleValidUntil(T0, plus(30 * HOUR))).toEqual(plus(BUNDLE_MAX_MS));
  });

  it('no slot: twelve hours', () => {
    expect(bundleValidUntil(T0, null)).toEqual(plus(UNSCHEDULED_MS));
  });

  it('past the slot’s end (overtime): one hour', () => {
    expect(bundleValidUntil(T0, plus(-SLOT_GRACE_MS))).toEqual(
      plus(OVERTIME_MS),
    );
    expect(bundleValidUntil(T0, plus(-2 * HOUR))).toEqual(plus(OVERTIME_MS));
    // Within the grace: until the grace ends.
    expect(bundleValidUntil(T0, plus(-10 * 60_000))).toEqual(
      plus(SLOT_GRACE_MS - 10 * 60_000),
    );
  });
});
