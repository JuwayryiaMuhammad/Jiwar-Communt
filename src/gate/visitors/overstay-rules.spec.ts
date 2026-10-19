import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_SETTING_LIMITS } from '../settings/gate-settings-rules';
import {
  expectedMinutes,
  OVERSTAY_SUBJECTS,
  overstayDue,
} from './overstay-rules';

const migration = readFileSync(
  join(
    __dirname,
    '../../..',
    'prisma/migrations/20261104090300_visit_overstay/migration.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');

describe('visit overstay (ADR 0056)', () => {
  it('a pass’s expected minutes win over the compound’s; none: no alert', () => {
    expect(expectedMinutes(30, 240)).toBe(30);
    expect(expectedMinutes(null, 240)).toBe(240);
    expect(expectedMinutes(undefined, null)).toBeNull();
  });

  it('is due its minutes after the entry', () => {
    expect(
      overstayDue(new Date('2026-11-04T10:00:00.000Z'), 90).toISOString(),
    ).toBe('2026-11-04T11:30:00.000Z');
  });

  it('matches its CHECKs: visitors only, the bounds and the default', () => {
    const q = OVERSTAY_SUBJECTS.map((x) => `'${x}'`).join(', ');
    expect(migration).toContain(`"subject_type" IN (${q})`);
    const v = GATE_SETTING_LIMITS.visitExpectedMinutes;
    expect(migration).toContain(
      `"visit_expected_minutes" SMALLINT DEFAULT ${v.default}`,
    );
    expect(migration).toContain(
      `"visit_expected_minutes" IS NULL OR "visit_expected_minutes" BETWEEN ${v.min} AND ${v.max}`,
    );
    expect(migration).toContain(
      `"expected_minutes" IS NULL OR "expected_minutes" BETWEEN ${v.min} AND ${v.max}`,
    );
  });
});
