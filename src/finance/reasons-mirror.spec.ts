import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../core/common/reasons';

const mirror = readFileSync(
  join(__dirname, '../../packages/api/src/reasons.ts'),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('money and the unit’s and the treasury’s reason codes in the dashboards’ mirror (ADR 0069, 0085)', () => {
  it.each([
    'planRequestDecline',
    'collectorVisitFail',
    'collectorVisitCancel',
    // ADR 0089.
    'vendorInvoiceReject',
    'vendorInvoiceCancel',
    'disbursementReject',
    'disbursementCancel',
    'budgetVariance',
    // ADR 0085.
    'custodyVariance',
    'custodyOutcome',
    'chequeBounce',
    'chequeReturn',
    'cashAdjust',
  ] as const)('%s is the backend’s list', (list) => {
    expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});
