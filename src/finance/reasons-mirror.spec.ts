import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../core/common/reasons';

const mirror = readFileSync(
  join(__dirname, '../../packages/api/src/reasons.ts'),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('money and the unit’s reason codes in the dashboards’ mirror (ADR 0069)', () => {
  it.each([
    'planRequestDecline',
    'collectorVisitFail',
    'collectorVisitCancel',
  ] as const)('%s is the backend’s list', (list) => {
    expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});
