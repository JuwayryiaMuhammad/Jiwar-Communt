import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTING_RANGES } from './defaults';

const read = (name: string) =>
  readFileSync(
    join(__dirname, `../../../prisma/migrations/${name}/migration.sql`),
    'utf8',
  );
// The no-show rules (ADR 0044), then the waitlist's hold (ADR 0070).
const migration =
  read('20261022090400_booking_suspensions') +
  read('20270112090500_booking_waitlist');
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
