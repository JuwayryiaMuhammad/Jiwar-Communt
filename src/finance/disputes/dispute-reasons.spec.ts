import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';

const repo = join(__dirname, '../../..');
const migration = readFileSync(
  join(repo, 'prisma/migrations/20261026090400_invoice_disputes/migration.sql'),
  'utf8',
);
const dashboards = readFileSync(
  join(repo, 'packages/api/src/reasons.ts'),
  'utf8',
);

describe('invoice dispute reasons (ADR 0048)', () => {
  it.each([
    ['invoiceDispute', 'reason_code'],
    ['invoiceDisputeReject', 'decision_reason_code'],
  ] as const)('%s is the CHECK’s and the dashboards’', (list, column) => {
    const quoted = REASON_CODES[list].map((c) => `'${c}'`).join(', ');
    expect(migration).toContain(`"${column}" IN (${quoted})`);
    expect(dashboards).toContain(`${list}: [${quoted}]`);
  });
});
