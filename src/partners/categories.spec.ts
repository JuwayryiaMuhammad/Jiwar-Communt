import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARTNER_CATEGORIES, isPartnerCategory } from './categories';

const migration = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20261112090100_partners_catalogue/migration.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = PARTNER_CATEGORIES.map((c) => `'${c}'`).join(', ');

describe('partner categories (ADR 0060)', () => {
  it.each(['partner_subcategories_category', 'partner_services_category'])(
    'the CHECK %s lists exactly the closed list, in order',
    (name) => {
      const at = migration.indexOf(`"${name}"`);
      expect(at).toBeGreaterThan(0);
      expect(migration.slice(at, migration.indexOf(';', at))).toContain(
        `IN (${quoted})`,
      );
    },
  );

  it('thirteen categories, snake_case, without duplicates', () => {
    expect(PARTNER_CATEGORIES).toHaveLength(13);
    expect(new Set(PARTNER_CATEGORIES).size).toBe(13);
    for (const c of PARTNER_CATEGORIES) expect(c).toMatch(/^[a-z][a-z_]*$/);
  });

  it('knows its categories and nothing else', () => {
    expect(isPartnerCategory('pharmacy')).toBe(true);
    expect(isPartnerCategory('taxi')).toBe(false);
    expect(isPartnerCategory('constructor')).toBe(false);
  });
});
