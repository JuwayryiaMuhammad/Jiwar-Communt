import { bookableWhen, isPeak, slotAt, slotsOfDate } from './facility-slots';

const CAIRO = 'Africa/Cairo';
const w = (weekday: number, startMinute: number, endMinute: number) => ({
  weekday,
  startMinute,
  endMinute,
});
// 2031-01-13 is a Monday; Cairo is UTC+2 in winter.
const cal = {
  hours: [w(1, 1020, 1320)],
  peaks: [w(1, 1110, 1200)],
  slotMinutes: 60,
  timeZone: CAIRO,
};

describe('a facility’s slots (ADR 0044)', () => {
  it('are its hours of the weekday, cut, each peak when it overlaps a peak time', () => {
    const slots = slotsOfDate('2031-01-13', cal);
    expect(slots.map((s) => [s.startsAt.toISOString(), s.peak])).toEqual([
      ['2031-01-13T15:00:00.000Z', false], // 17:00–18:00
      ['2031-01-13T16:00:00.000Z', true], // 18:00–19:00 overlaps 18:30
      ['2031-01-13T17:00:00.000Z', true], // 19:00–20:00
      ['2031-01-13T18:00:00.000Z', false], // 20:00–21:00: the peak ended at 20:00
      ['2031-01-13T19:00:00.000Z', false],
    ]);
    expect(slotsOfDate('2031-01-14', cal)).toEqual([]);
  });

  it('a booking names a slot’s start exactly', () => {
    expect(slotAt(new Date('2031-01-13T16:00:00Z'), cal)).toMatchObject({
      peak: true,
    });
    expect(slotAt(new Date('2031-01-13T16:30:00Z'), cal)).toBeNull();
    expect(slotAt(new Date('2031-01-13T21:00:00Z'), cal)).toBeNull();
  });

  it('touching a peak time is not overlapping it', () => {
    expect(
      isPeak(
        {
          startsAt: new Date('2031-01-13T18:00:00Z'),
          endsAt: new Date('2031-01-13T19:00:00Z'),
        },
        { ...cal, peaks: [w(1, 1110, 1200), w(1, 1260, 1320)] },
      ),
    ).toBe(false);
  });

  it('a slot is bookable from its lead time and up to its last local day', () => {
    const slot = slotsOfDate('2031-01-13', cal)[0]; // 17:00 local
    const rules = { minMinutesBefore: 60, maxDaysAhead: 2 };
    expect(
      bookableWhen(slot, new Date('2031-01-13T14:00:00Z'), rules, CAIRO),
    ).toBeNull();
    expect(
      bookableWhen(slot, new Date('2031-01-13T14:00:01Z'), rules, CAIRO),
    ).toBe('too_soon');
    // Two local days ahead, whatever the hour: Saturday 23:30 local books Monday.
    expect(
      bookableWhen(slot, new Date('2031-01-11T21:30:00Z'), rules, CAIRO),
    ).toBeNull();
    expect(
      bookableWhen(slot, new Date('2031-01-10T21:59:00Z'), rules, CAIRO),
    ).toBe('too_far');
  });
});
