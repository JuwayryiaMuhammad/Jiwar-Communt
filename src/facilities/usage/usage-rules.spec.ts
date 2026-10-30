import type { FacilityRules } from '../setup/facility-rules';
import { daysOf, usageOf, usagePeriod } from './usage-rules';

const rules = (r: Partial<FacilityRules> = {}): FacilityRules => ({
  slotMinutes: 60,
  capacity: 2,
  capacityUnit: 'bookings',
  maxDaysAhead: 14,
  minMinutesBefore: 0,
  cancelCutoffMinutes: 0,
  maxGuests: 4,
  requiresApproval: false,
  requiresMembership: false,
  childOccasions: false,
  weeklyQuota: 7,
  peakQuota: 7,
  ...r,
});
const at = (h: number) => new Date(Date.UTC(2027, 0, 4, h));
const slot = (h: number) => ({ startsAt: at(h), endsAt: at(h + 1) });
const booking = (h: number, status: string, peak = false, partySize = 1) => ({
  ...slot(h),
  status,
  peak,
  partySize,
});

describe('facility usage (ADR 0067)', () => {
  it('a period is 30 days ending today by default, its end not before its start, a year and a day at most', () => {
    expect(usagePeriod({}, '2027-01-30')).toEqual({
      from: '2027-01-01',
      to: '2027-01-30',
      days: 30,
    });
    expect(
      usagePeriod({ from: '2027-02-01', to: '2027-01-31' }, '2027-03-01'),
    ).toEqual([{ field: 'to', code: 'ENDS_BEFORE_START' }]);
    expect(
      usagePeriod({ from: '2026-01-01', to: '2027-01-01' }, '2027-03-01'),
    ).toMatchObject({
      days: 366,
    });
    expect(
      usagePeriod({ from: '2026-01-01', to: '2027-01-02' }, '2027-03-01'),
    ).toEqual([
      { field: 'from', code: 'PERIOD_TOO_LONG', params: { max: 366 } },
    ]);
    expect(daysOf({ from: '2028-02-28', to: '2028-03-01' })).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('counts bookings by status; use is booked time over open time and capacity, a closed slot not open', () => {
    const u = usageOf(
      rules(),
      [slot(8), slot(9), slot(10), slot(11)],
      [{ startsAt: at(11), endsAt: at(13) }],
      [
        booking(8, 'confirmed', true),
        booking(8, 'no_show'),
        booking(9, 'pending'),
        booking(9, 'cancelled'),
        booking(10, 'rejected'),
      ],
    );
    expect(u).toEqual({
      bookings: {
        pending: 1,
        confirmed: 1,
        rejected: 1,
        cancelled: 1,
        no_show: 1,
      },
      openMinutes: 180,
      bookedMinutes: 180,
      use: 50,
      noShows: 1,
      noShowRate: 50,
      peakShare: 33,
    });
  });

  it('a facility counted by people holds a place per person; never open is no use at all', () => {
    const u = usageOf(
      rules({ capacityUnit: 'people', capacity: 10 }),
      [slot(8)],
      [],
      [booking(8, 'confirmed', false, 4)],
    );
    expect(u).toMatchObject({ bookedMinutes: 240, use: 40, peakShare: 0 });
    expect(usageOf(rules(), [], [], [])).toMatchObject({
      openMinutes: 0,
      use: null,
      noShowRate: null,
      peakShare: null,
    });
  });
});
