import { busiestWeek, withinQuota } from './quota-window';

const DAY = 86_400_000;
const at = (day: number, hour = 10) =>
  new Date(Date.UTC(2031, 0, 1) + day * DAY + hour * 3_600_000);

describe('a unit’s quota: any 7 consecutive days (ADR 0044)', () => {
  it('counts the new booking with those within 7 days of it, either side', () => {
    expect(busiestWeek([], at(10))).toBe(1);
    expect(busiestWeek([at(4, 11)], at(10))).toBe(2); // within 7 days before
    expect(busiestWeek([at(16, 9)], at(10))).toBe(2); // within 7 days after
  });

  it('exactly 7 days apart are two different weeks', () => {
    expect(busiestWeek([at(3)], at(10))).toBe(1);
    expect(busiestWeek([at(17)], at(10))).toBe(1);
  });

  it('a week is never wider than 7 days: one before and one after, 12 days apart, never share one', () => {
    // 2 held: day 4 and day 16. The new one on day 10 makes two weeks of 2,
    // never one of 3.
    expect(busiestWeek([at(4, 11), at(16, 9)], at(10))).toBe(2);
    expect(withinQuota([at(4, 11), at(16, 9)], at(10), 2)).toBe(true);
  });

  it('an earlier booking that would fill a week ending at a later one is refused', () => {
    // Held: day 11 and day 15. Day 9 would make 9, 11, 15 within [9, 16).
    expect(busiestWeek([at(11), at(15)], at(9))).toBe(3);
    expect(withinQuota([at(11), at(15)], at(9), 2)).toBe(false);
  });

  it('two a week by default: the third within any 7 days is the one refused', () => {
    expect(withinQuota([at(1)], at(2), 2)).toBe(true);
    expect(withinQuota([at(1), at(2)], at(3), 2)).toBe(false);
    expect(withinQuota([at(1), at(2)], at(9), 2)).toBe(true);
  });
});
