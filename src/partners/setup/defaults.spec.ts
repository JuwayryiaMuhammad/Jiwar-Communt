import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARTNER_CATEGORIES } from '../categories';
import { DEFAULT_SUBCATEGORIES, PARTNER_PRICE_UNITS } from './defaults';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261112090100_partners_catalogue/migration.sql',
  ),
  'utf8',
);

describe('partner set-up defaults (ADR 0060)', () => {
  it('the migration backfills exactly the seeded sub-categories', () => {
    const rows = [
      ...migration.matchAll(
        /\('([a-z_]+)', '([a-z_]+)', '([^']+)', '([^']+)', (\d+)\)/g,
      ),
    ].map(([, category, key, nameEn, nameAr, position]) => ({
      category,
      key,
      nameEn,
      nameAr,
      position: Number(position),
    }));
    expect(rows).toEqual(DEFAULT_SUBCATEGORIES);
  });

  it('every category has at least one, keys are unique and well formed', () => {
    for (const category of PARTNER_CATEGORIES)
      expect(DEFAULT_SUBCATEGORIES.some((s) => s.category === category)).toBe(
        true,
      );
    const keys = DEFAULT_SUBCATEGORIES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
  });

  it('the price units are the CHECK’s', () => {
    expect(migration.replace(/\s+/g, ' ')).toContain(
      `"unit" IN (${PARTNER_PRICE_UNITS.map((u) => `'${u}'`).join(', ')})`,
    );
  });
});
