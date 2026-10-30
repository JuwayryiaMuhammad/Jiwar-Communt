import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';

const mirror = readFileSync(
  join(__dirname, '../../../packages/api/src/reasons.ts'),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('the asset register’s, the store’s, energy’s, readiness’s, facility bans’ and field safety’s reason codes in the dashboards’ mirror (ADR 0064, 0065, 0066, 0067)', () => {
  it.each([
    'assetOutOfService',
    'assetRetire',
    'planDefer',
    'planSkip',
    'planDeactivate',
    'inspectionCancel',
    'replacementReason',
    'replacementDecline',
    // ADR 0065.
    'stockAdjust',
    'partRequestDecline',
    'partRequestCancel',
    'ticketCostVoid',
    'ticketCompletionAction',
    'quoteSuggestionDismiss',
    'contractTerminate',
    // ADR 0066.
    'meterRetire',
    'readingCorrect',
    'outageKind',
    'outageCancel',
    // ADR 0067.
    'readinessItemCancel',
    'contractReviewDecision',
    'facilityBan',
    'facilityBanLift',
    'workPermitReject',
    'workPermitRevoke',
    'workHazard',
  ] as const)('%s is the backend’s list', (list) => {
    expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});
