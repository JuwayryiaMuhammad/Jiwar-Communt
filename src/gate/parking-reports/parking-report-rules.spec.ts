import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';

describe('the parking reports’ reason codes (ADR 0045)', () => {
  it('parkingReportClose matches its CHECK and the dashboards’ mirror', () => {
    const read = (path: string) =>
      readFileSync(join(__dirname, '../../..', path), 'utf8');
    const quoted = REASON_CODES.parkingReportClose
      .map((c) => `'${c}'`)
      .join(', ');
    expect(
      read(
        'prisma/migrations/20261023090600_parking_reports/migration.sql',
      ).replace(/\s+/g, ' '),
    ).toContain(`IN (${quoted})`);
    expect(read('packages/api/src/reasons.ts')).toContain(
      `parkingReportClose: [${quoted}]`,
    );
  });
});
