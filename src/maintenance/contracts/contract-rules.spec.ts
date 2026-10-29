import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { CONTRACT_KINDS, contractStatus } from './contract-rules';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261208090200_maintenance_contracts/migration.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

describe('maintenance contracts (ADR 0065)', () => {
  it('a status is read from the compound’s day; the end date is its last day', () => {
    const c = {
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
      terminated: false,
    };
    expect(contractStatus(c, '2025-12-31')).toBe('upcoming');
    expect(contractStatus(c, '2026-01-01')).toBe('active');
    expect(contractStatus(c, '2026-12-31')).toBe('active');
    expect(contractStatus(c, '2027-01-01')).toBe('ended');
    expect(contractStatus({ ...c, terminated: true }, '2026-06-01')).toBe(
      'terminated',
    );
  });

  it('the CHECKs repeat the kinds and the termination reasons', () => {
    expect(migration).toContain(`"kind" IN (${quoted(CONTRACT_KINDS)})`);
    expect(migration).toContain(
      `"termination_reason" IN (${quoted(REASON_CODES.contractTerminate)})`,
    );
  });
});
