import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { DEFAULT_PLACES } from './default-places';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261025090300_places/migration.sql',
  ),
  'utf8',
);
/** The backfill block alone: the DO $$ loop over the compounds. */
const loop = migration.slice(
  migration.lastIndexOf('FOR t IN SELECT "id" FROM "tenants"'),
);

describe('the default places (ADR 0047)', () => {
  it('are the seven of the mobile contract, other last', () => {
    expect(DEFAULT_PLACES.map((p) => p.key)).toEqual([
      'main_gate',
      'north_gate',
      'phase_a',
      'phase_b',
      'clubhouse',
      'parking',
      'other',
    ]);
  });

  it('match the backfill of existing compounds, row for row', () => {
    const rows = [
      ...loop.matchAll(/\('([a-z_]+)', '([^']+)', '([^']+)', (\d+)\)/g),
    ].map(([, key, nameAr, nameEn, position]) => ({
      key,
      nameAr,
      nameEn,
      position: Number(position),
    }));
    expect(rows).toEqual(DEFAULT_PLACES);
  });

  it('placeKey matches its CHECK and the dashboards’ mirror', () => {
    const quoted = REASON_CODES.placeKey.map((c) => `'${c}'`).join(', ');
    expect(migration.replace(/\s+/g, ' ')).toContain(`IN (${quoted})`);
    expect(
      readFileSync(
        join(__dirname, '../../../packages/api/src/reasons.ts'),
        'utf8',
      ),
    ).toContain(`placeKey: [${quoted}]`);
    expect([...REASON_CODES.placeKey]).toEqual(
      DEFAULT_PLACES.map((p) => p.key),
    );
  });
});
