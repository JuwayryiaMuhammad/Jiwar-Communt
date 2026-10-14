import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTING_RANGES } from './defaults';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261022090400_booking_suspensions/migration.sql',
  ),
  'utf8',
);
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('facility settings (ADR 0044)', () => {
  it('each setting has the default and the range of its column', () => {
    for (const [name, range] of Object.entries(SETTING_RANGES)) {
      const column = snake(name);
      expect(migration).toContain(
        `"${column}" INTEGER NOT NULL DEFAULT ${range.default}`,
      );
      expect(migration).toContain(
        `"${column}" BETWEEN ${range.min} AND ${range.max}`,
      );
    }
  });

  it('three no-shows in thirty days suspend for fourteen days', () => {
    expect(SETTING_RANGES.noShowThreshold.default).toBe(3);
    expect(SETTING_RANGES.noShowWindowDays.default).toBe(30);
    expect(SETTING_RANGES.suspensionDays.default).toBe(14);
  });
});
