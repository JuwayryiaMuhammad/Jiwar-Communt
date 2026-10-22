import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTING_RANGES } from './defaults';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261112090100_partners_catalogue/migration.sql',
  ),
  'utf8',
);
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('partner settings (ADR 0060)', () => {
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

  it('new for 30 days, late from 22:00, five live requests, desk links for 90 days', () => {
    expect(SETTING_RANGES.newDays.default).toBe(30);
    expect(SETTING_RANGES.lateFromMinute.default).toBe(22 * 60);
    expect(SETTING_RANGES.maxLiveRequests.default).toBe(5);
    expect(SETTING_RANGES.ratingDays.default).toBe(14);
    expect(SETTING_RANGES.complaintDays.default).toBe(14);
    expect(SETTING_RANGES.deskLinkDays.default).toBe(90);
  });
});
