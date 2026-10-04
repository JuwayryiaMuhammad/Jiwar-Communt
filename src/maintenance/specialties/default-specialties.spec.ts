import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CATEGORIES } from '../categories/default-categories';
import {
  DEFAULT_CATEGORY_SPECIALTIES,
  DEFAULT_SPECIALTIES,
} from './default-specialties';

const backfill = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261008090000_dispatch_engine/migration.sql',
  ),
  'utf8',
);

describe('default specialties', () => {
  it('are the five of ADR 0033', () => {
    expect(DEFAULT_SPECIALTIES.map((s) => s.key)).toEqual([
      'plumbing',
      'electrical',
      'ac',
      'carpentry',
      'general',
    ]);
  });

  it('match the backfill of existing compounds, row for row', () => {
    const values = backfill.slice(backfill.indexOf('FROM (VALUES'));
    const rows = [...values.matchAll(/\('([a-z_]+)', '([^']+)', '([^']+)'\)/g)]
      .slice(0, DEFAULT_SPECIALTIES.length)
      .map(([, key, nameAr, nameEn]) => ({ key, nameAr, nameEn }));
    expect(rows).toEqual([...DEFAULT_SPECIALTIES]);
  });

  it('link each default category to its namesake, as the backfill does', () => {
    expect(DEFAULT_CATEGORY_SPECIALTIES.map((l) => l.categoryKey)).toEqual(
      DEFAULT_CATEGORIES.map((c) => c.key),
    );
    expect(
      DEFAULT_CATEGORY_SPECIALTIES.every(
        (l) => l.categoryKey === l.specialtyKey,
      ),
    ).toBe(true);
    // The backfill joins category and specialty on the same key.
    expect(backfill).toContain(`s."key" = c."key"`);
    for (const l of DEFAULT_CATEGORY_SPECIALTIES)
      expect(backfill).toContain(`'${l.categoryKey}'`);
  });

  it('start the dispatch settings of an existing compound with automatic dispatch off', () => {
    const settings = backfill.slice(
      backfill.indexOf('INSERT INTO "maintenance_dispatch_settings"'),
    );
    expect(settings).toContain('VALUES (t."id", false, CURRENT_TIMESTAMP)');
  });
});
