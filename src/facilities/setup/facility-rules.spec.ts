import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULE_RANGES, rulesOf, withDefaults } from './facility-rules';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261022090000_facilities/migration.sql',
  ),
  'utf8',
);

const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('a facility’s rules (ADR 0044)', () => {
  it('each rule has the range of its CHECK', () => {
    for (const [name, range] of Object.entries(RULE_RANGES))
      expect(migration).toContain(
        `("${snake(name)}" IS NULL OR "${snake(name)}" BETWEEN ${range.min} AND ${range.max})`,
      );
  });

  it('a new bookable facility takes the defaults for what is left out: 14 days ahead, an hour before, two hours to cancel, no guests, 2 a week and 1 at peak', () => {
    expect(withDefaults({ slotMinutes: 60, capacity: 1 })).toEqual({
      slotMinutes: 60,
      capacity: 1,
      capacityUnit: 'bookings',
      maxDaysAhead: 14,
      minMinutesBefore: 60,
      cancelCutoffMinutes: 120,
      maxGuests: 0,
      requiresApproval: false,
      requiresMembership: false,
      weeklyQuota: 2,
      peakQuota: 1,
    });
    expect(
      withDefaults({
        slotMinutes: 90,
        capacity: 20,
        capacityUnit: 'people',
        maxGuests: 4,
      }),
    ).toMatchObject({ capacityUnit: 'people', maxGuests: 4 });
  });

  it('a walk-in facility has no rules', () => {
    expect(
      rulesOf({
        mode: 'walk_in',
        slotMinutes: null,
        capacity: null,
        capacityUnit: null,
        maxDaysAhead: null,
        minMinutesBefore: null,
        cancelCutoffMinutes: null,
        maxGuests: null,
        requiresApproval: false,
        requiresMembership: false,
        weeklyQuota: null,
        peakQuota: null,
      }),
    ).toBeNull();
  });
});
