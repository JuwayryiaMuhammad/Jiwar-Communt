import {
  addMonths,
  leadTimes,
  leadToTell,
  nextDueOn,
  stateOf,
} from './compliance-rules';

describe('compliance rules (ADR 0087)', () => {
  it('the item’s lead times, else the compound’s, longest first and once each', () => {
    expect(leadTimes([], [7, 60, 30])).toEqual([60, 30, 7]);
    expect(leadTimes([14, 14, 90], [60, 30, 7])).toEqual([90, 14]);
  });

  it('a due day is valid beyond the longest lead time, due soon within it, overdue past it', () => {
    const leads = [60, 30, 7];
    // 2027-03-02 is 60 days on: within the longest lead time.
    expect(stateOf('2027-03-03', '2027-01-01', leads)).toBe('valid');
    expect(stateOf('2027-03-02', '2027-01-01', leads)).toBe('due_soon');
    expect(stateOf('2027-01-01', '2027-01-01', leads)).toBe('due_soon');
    expect(stateOf('2026-12-31', '2027-01-01', leads)).toBe('overdue');
  });

  it('each lead time is told once, the shortest reached, never a longer one after', () => {
    const leads = [60, 30, 7];
    expect(leadToTell('2027-03-10', '2027-01-01', leads, null)).toBeNull();
    expect(leadToTell('2027-03-01', '2027-01-01', leads, null)).toBe(60);
    expect(leadToTell('2027-03-01', '2027-01-01', leads, 60)).toBeNull();
    // Made 20 days ahead: 30 is told, never 60 after it.
    expect(leadToTell('2027-01-21', '2027-01-01', leads, null)).toBe(30);
    expect(leadToTell('2027-01-21', '2027-01-01', leads, 30)).toBeNull();
    expect(leadToTell('2027-01-05', '2027-01-01', leads, 30)).toBe(7);
    // Past the day: the overdue notice, not a lead one.
    expect(leadToTell('2026-12-31', '2027-01-01', leads, 7)).toBeNull();
  });

  it('months land on the same day, or the last of a shorter month', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2027-11-15', 12)).toBe('2028-11-15');
    expect(addMonths('2027-12-15', 1)).toBe('2028-01-15');
  });

  it('the next due day: given, else the expiry, else the recurrence; none for a one-off', () => {
    const dueOn = '2027-01-10';
    expect(
      nextDueOn({ dueOn, recurrenceMonths: 12, nextDueOn: '2027-06-01' }),
    ).toBe('2027-06-01');
    expect(
      nextDueOn({ dueOn, recurrenceMonths: 12, expiresOn: '2027-12-31' }),
    ).toBe('2027-12-31');
    expect(nextDueOn({ dueOn, recurrenceMonths: 6 })).toBe('2027-07-10');
    expect(nextDueOn({ dueOn, recurrenceMonths: null })).toBeNull();
  });
});
