import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { acknowledgementDigest, HAZARDS, unionOf } from './safety-rules';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261222090300_work_safety/migration.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

const ack = {
  instructionId: '0192a5f0-1c2b-7d3e-8f40-000000006711',
  version: 3,
  textEn: 'Lock out the supply',
  textAr: 'افصل التيار',
  accountId: '0192a5f0-1c2b-7d3e-8f40-000000006712',
  ticketId: '0192a5f0-1c2b-7d3e-8f40-000000006713',
  cycle: 1,
};

describe('field safety rules (ADR 0067)', () => {
  it('the hazards and the permit reasons are the CHECKs’', () => {
    expect(migration).toContain(
      `"requires_permit" <@ ARRAY[${quoted(HAZARDS)}]::text[]`,
    );
    expect(migration).toContain(`"hazard" IN (${quoted(HAZARDS)})`);
    expect(migration).toContain(
      `"reject_reason" IN (${quoted(REASON_CODES.workPermitReject)})`,
    );
    expect(migration).toContain(
      `"revoke_reason" IN (${quoted(REASON_CODES.workPermitRevoke)})`,
    );
  });

  it('a category’s and an asset type’s hazards are one list, once each, in the closed list’s order', () => {
    expect(
      unionOf(['pool_chemicals', 'height'], ['height', 'hot_work']),
    ).toEqual(['hot_work', 'height', 'pool_chemicals']);
    expect(unionOf([], [])).toEqual([]);
    expect(unionOf(['fire'])).toEqual([]);
  });

  it('the acknowledgement’s hash is of exactly what was shown, to whom, for which ticket and cycle', () => {
    const digest = acknowledgementDigest(ack);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(acknowledgementDigest({ ...ack })).toBe(digest);
    for (const change of [
      { textEn: 'Lock out the supply.' },
      { textAr: 'افصل التيار.' },
      { version: 4 },
      { accountId: '0192a5f0-1c2b-7d3e-8f40-000000006714' },
      { cycle: 2 },
    ])
      expect(acknowledgementDigest({ ...ack, ...change })).not.toBe(digest);
  });
});
