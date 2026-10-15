import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';

describe('refund reasons (ADR 0048)', () => {
  it('the reversal reasons are the CHECK’s and the dashboards’', () => {
    const repo = join(__dirname, '../../..');
    const migration = readFileSync(
      join(repo, 'prisma/migrations/20261026090500_refunds/migration.sql'),
      'utf8',
    );
    const dashboards = readFileSync(
      join(repo, 'packages/api/src/reasons.ts'),
      'utf8',
    );
    const quoted = REASON_CODES.refundReverse.map((c) => `'${c}'`).join(', ');
    expect(migration).toContain(`"reason_code" IN (${quoted})`);
    expect(dashboards).toContain(`refundReverse: [${quoted}]`);
  });
});
