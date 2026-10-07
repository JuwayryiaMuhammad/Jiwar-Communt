import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CATEGORIES } from '../categories/default-categories';
import { DEFAULT_PREVENTIVE_SERVICES } from './default-preventive-services';

const backfill = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261014090700_preventive_services/migration.sql',
  ),
  'utf8',
);

describe('default preventive services', () => {
  it('are the four of ADR 0038, in the design’s order, each under a default category', () => {
    expect(DEFAULT_PREVENTIVE_SERVICES.map((s) => s.key)).toEqual([
      'ac_service',
      'water_heater',
      'plumbing_check',
      'electrical_check',
    ]);
    expect(DEFAULT_PREVENTIVE_SERVICES.map((s) => s.position)).toEqual([
      1, 2, 3, 4,
    ]);
    const categories = DEFAULT_CATEGORIES.map((c) => c.key);
    for (const s of DEFAULT_PREVENTIVE_SERVICES)
      expect(categories).toContain(s.categoryKey);
  });

  it('match the backfill of existing compounds, row for row', () => {
    const values = backfill.slice(backfill.indexOf('FROM (VALUES'));
    const rows = [
      ...values.matchAll(
        /\('([a-z_]+)', '([^']+)', '([^']+)', '([a-z_]+)', (\d+)\)/g,
      ),
    ].map(([, key, nameAr, nameEn, categoryKey, position]) => ({
      key,
      nameAr,
      nameEn,
      categoryKey,
      position: Number(position),
    }));
    expect(rows).toEqual([...DEFAULT_PREVENTIVE_SERVICES]);
    // Safe to rerun, and never a failed deploy over a missing category.
    expect(backfill).toContain('ON CONFLICT ("tenant_id", "key") DO NOTHING');
    expect(backfill).toMatch(/JOIN "ticket_categories" c\s+ON c\."tenant_id"/);
  });
});
