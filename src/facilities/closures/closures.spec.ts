import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';

const repo = join(__dirname, '../../..');
const migration = readFileSync(
  join(
    repo,
    'prisma/migrations/20261022090300_facility_closures/migration.sql',
  ),
  'utf8',
);
const dashboards = readFileSync(
  join(repo, 'packages/api/src/reasons.ts'),
  'utf8',
);
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('closures (ADR 0044)', () => {
  it('the reason lists are the CHECKs’ and the dashboards’', () => {
    expect(migration).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.facilityClosure)})`,
    );
    expect(migration).toContain(
      `"lift_reason_code" IN (${quoted(REASON_CODES.facilityClosureLift)})`,
    );
    for (const list of ['facilityClosure', 'facilityClosureLift'] as const)
      expect(dashboards).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });

  it('a closure cancels bookings with the system’s `facility_closed`', () => {
    expect(REASON_CODES.bookingSystemCancel).toContain('facility_closed');
    expect(migration).toContain(`"cancel_reason" = 'facility_closed'`);
  });
});
