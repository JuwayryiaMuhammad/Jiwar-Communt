import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AREA_CODE, COMMON_AREA_KINDS } from './area-rules';

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261201090200_common_areas/migration.sql',
  ),
  'utf8',
);

describe('common area rules (ADR 0064)', () => {
  it('the kinds and the code shape are the CHECKs’', () => {
    expect(sql).toContain(
      `CHECK ("kind" IN (${COMMON_AREA_KINDS.map((k) => `'${k}'`).join(', ')}))`,
    );
    expect(sql).toContain(`CHECK ("code" ~ '${AREA_CODE.source}')`);
  });

  it('a code is short, starts with a letter or digit, and has no spaces', () => {
    for (const ok of ['B12', 'POOL-1', 'roof.north', 'a_b'])
      expect(AREA_CODE.test(ok)).toBe(true);
    for (const bad of ['', '-x', 'with space', 'x'.repeat(41), 'برج'])
      expect(AREA_CODE.test(bad)).toBe(false);
  });
});
