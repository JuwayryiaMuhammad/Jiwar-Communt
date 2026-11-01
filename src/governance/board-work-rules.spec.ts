import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  POLL_WEIGHTINGS,
  scaledWeight,
  UNIT_SHARE_LIMITS,
  unscaledWeight,
} from './polls/poll-rules';

const migration = (name: string) =>
  readFileSync(
    join(__dirname, `../../prisma/migrations/${name}/migration.sql`),
    'utf8',
  ).replace(/\s+/g, ' ');
const quoted = (list: readonly string[]) =>
  list.map((v) => `'${v}'`).join(', ');

describe('the board’s work: its lists are its CHECKs’ (ADR 0075)', () => {
  const weighted = migration('20270216090000_governance_weighted_polls');

  it('a poll’s weightings and a unit’s share', () => {
    expect(weighted).toContain(`"weighting" IN (${quoted(POLL_WEIGHTINGS)})`);
    expect(weighted).toContain(
      `"share" > ${UNIT_SHARE_LIMITS.min} AND "share" <= ${UNIT_SHARE_LIMITS.max}`,
    );
  });
});

describe('weights as whole ten-thousandths (ADR 0075)', () => {
  it('scales four decimals exactly, and back', () => {
    expect(scaledWeight('12.5')).toBe(125_000);
    expect(scaledWeight('0.0001')).toBe(1);
    expect(scaledWeight('100.0000')).toBe(1_000_000);
    expect(scaledWeight(null)).toBe(0);
    expect(unscaledWeight(125_000)).toBe('12.5000');
    expect(unscaledWeight(1)).toBe('0.0001');
    expect(unscaledWeight(0)).toBe('0.0000');
    // 0.1 + 0.2 in floating point is not 0.3; in ten-thousandths it is.
    expect(unscaledWeight(scaledWeight('0.1') + scaledWeight('0.2'))).toBe(
      '0.3000',
    );
  });
});
