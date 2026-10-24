import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  firstNameOf,
  REPRESENTATIVE_END_REASONS,
  REPRESENTATIVE_MATTER_EFFECT_REASONS,
} from './representative-rules';

describe('representative rules (ADR 0059)', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20261115090400_governance_representatives/migration.sql',
    ),
    'utf8',
  );

  it('every end reason is in the CHECK, by who ends it', () => {
    for (const reason of REPRESENTATIVE_END_REASONS)
      expect(sql).toContain(`'${reason}'`);
    expect(sql).toContain(
      `"end_reason" IN ('ended', 'replaced') AND "ended_by_matter_id" IS NOT NULL`,
    );
    expect(sql).toContain(
      `"end_reason" IN ('no_longer_owner', 'account_closed') AND "ended_by_matter_id" IS NULL`,
    );
  });

  it('every reason an approved matter changed nothing is in the CHECK', () => {
    expect(sql).toContain(
      `"effect_reason" IN (${REPRESENTATIVE_MATTER_EFFECT_REASONS.map((r) => `'${r}'`).join(', ')})`,
    );
  });

  it('shows a first name only', () => {
    expect(firstNameOf('  Mona  Adel Hassan ')).toBe('Mona');
    expect(firstNameOf(null)).toBeNull();
  });
});
