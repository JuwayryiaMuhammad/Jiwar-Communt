import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COMPLAINT_CATEGORIES, SETTING_RANGES } from './defaults';

const backfill = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261020090100_neighbours_setup/migration.sql',
  ),
  'utf8',
);
/** The backfill block alone: the DO $$ loop over the compounds. */
const loop = backfill.slice(
  backfill.lastIndexOf('FOR t IN SELECT "id" FROM "tenants"'),
);

const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('default complaint categories and neighbours settings', () => {
  it('are the eight categories of ADR 0042', () => {
    expect(DEFAULT_COMPLAINT_CATEGORIES.map((c) => c.key)).toEqual([
      'noise',
      'parking',
      'pets',
      'garbage',
      'smoking',
      'damage',
      'rules',
      'other',
    ]);
  });

  it('the categories match the backfill of existing compounds, row for row', () => {
    const rows = [
      ...loop.matchAll(/\('([a-z_]+)', '([^']+)', '([^']+)'\)/g),
    ].map(([, key, nameAr, nameEn]) => ({ key, nameAr, nameEn }));
    expect(rows).toEqual(DEFAULT_COMPLAINT_CATEGORIES);
  });

  it('each setting has the default and the range of its column', () => {
    for (const [name, range] of Object.entries(SETTING_RANGES)) {
      const column = snake(name);
      expect(backfill).toContain(
        `"${column}" INTEGER NOT NULL DEFAULT ${range.default}`,
      );
      expect(backfill).toContain(
        `"${column}" BETWEEN ${range.min} AND ${range.max}`,
      );
    }
  });

  it('five open complaints, thirty days lost and found, fourteen days lending', () => {
    expect(SETTING_RANGES.maxOpenComplaints.default).toBe(5);
    expect(SETTING_RANGES.lostFoundExpiryDays.default).toBe(30);
    expect(SETTING_RANGES.lendingExpiryDays.default).toBe(14);
  });
});
