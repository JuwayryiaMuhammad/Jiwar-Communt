import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  APPROVAL_TYPES,
  DEFAULT_DEADLINE_DAYS,
  SETTING_TYPES,
  THRESHOLD_TYPES,
} from './approval-rules';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const settings = read(
  'prisma/migrations/20261102090200_governance_approval_settings/migration.sql',
);
const requests = read(
  'prisma/migrations/20261102090300_governance_approval_requests/migration.sql',
);
const mirror = read('packages/api/src/reasons.ts');
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('board matters’ lists (ADR 0055)', () => {
  it('the approval types and the settings’ rows are the CHECKs’', () => {
    expect(requests).toContain(`"type" IN (${quoted(APPROVAL_TYPES)})`);
    expect(settings).toContain(`"type" IN (${quoted(SETTING_TYPES)})`);
    expect(settings).toContain(`"type" IN (${quoted(THRESHOLD_TYPES)})`);
  });

  it('the backfill gives every compound the defaults a new one gets', () => {
    for (const type of SETTING_TYPES)
      expect(settings).toContain(
        `(t."id", '${type}', ${DEFAULT_DEADLINE_DAYS[type]})`,
      );
  });

  it('a withdrawal’s codes are its CHECK’s and the mirror’s', () => {
    expect(requests).toContain(
      `"withdraw_reason_code" IN (${quoted(REASON_CODES.approvalWithdraw)})`,
    );
    expect(mirror).toContain(
      `approvalWithdraw: [${quoted(REASON_CODES.approvalWithdraw)}]`,
    );
  });
});
