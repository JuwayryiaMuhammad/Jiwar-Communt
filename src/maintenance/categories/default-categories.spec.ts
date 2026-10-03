import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CATEGORIES } from './default-categories';

const backfill = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261007090100_maintenance/migration.sql',
  ),
  'utf8',
);

describe('default ticket categories', () => {
  it('are the five of ADR 0032, each allowed on a common area', () => {
    expect(DEFAULT_CATEGORIES.map((c) => c.key)).toEqual([
      'plumbing',
      'electrical',
      'ac',
      'carpentry',
      'general',
    ]);
    expect(DEFAULT_CATEGORIES.every((c) => c.commonAreaAllowed)).toBe(true);
  });

  it('match the backfill of existing compounds, row for row', () => {
    const values = backfill.slice(backfill.indexOf('FROM (VALUES'));
    const rows = [
      ...values.matchAll(/\('([a-z_]+)', '([^']+)', '([^']+)', '([a-z]+)'\)/g),
    ].map(([, key, nameAr, nameEn, defaultPriority]) => ({
      key,
      nameAr,
      nameEn,
      defaultPriority,
    }));
    expect(rows).toEqual(
      DEFAULT_CATEGORIES.map(({ key, nameAr, nameEn, defaultPriority }) => ({
        key,
        nameAr,
        nameEn,
        defaultPriority,
      })),
    );
    // The backfill sets common_area_allowed to true for every row.
    expect(backfill).toContain('c.priority::"ticket_priority", true,');
  });
});
