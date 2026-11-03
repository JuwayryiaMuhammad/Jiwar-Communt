import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_APPEAL_KINDS } from '../../core/board-matters/board-matters';
import { MANAGEMENT_COMPLAINT_CATEGORIES } from '../appeals/management-complaints';
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
/** ADR 0059 widened the settings' types with `objection`, and backfilled it. */
const voice = read(
  'prisma/migrations/20261115090500_governance_voice/migration.sql',
);
const requests = read(
  'prisma/migrations/20261102090300_governance_approval_requests/migration.sql',
);
/**
 * ADR 0082 widened the types (`compensation_above_limit`), then ADR 0075
 * (`manager_handover_override`): the newest migration that sets each CHECK
 * is the one the lists match; the backfills are in each one's own.
 */
const authority = `${read(
  'prisma/migrations/20270406090200_compensation_authority/migration.sql',
)} ${read('prisma/migrations/20270518090610_handover_approval_type/migration.sql')}`;
/** ADR 0089 then widened the request and setting types with `budget_transfer`. */
const planning = read(
  'prisma/migrations/20270601090000_budget_planning/migration.sql',
);
const latest = planning;
const mirror = read('packages/api/src/reasons.ts');
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('board matters’ lists (ADR 0055)', () => {
  it('the approval types and the settings’ rows are the CHECKs’', () => {
    expect(latest).toContain(`"type" IN (${quoted(APPROVAL_TYPES)})`);
    expect(latest).toContain(`"type" IN (${quoted(SETTING_TYPES)})`);
    expect(authority).toContain(`"type" IN (${quoted(THRESHOLD_TYPES)})`);
  });

  it('the backfill gives every compound the defaults a new one gets', () => {
    for (const type of SETTING_TYPES)
      expect(`${settings} ${voice} ${authority} ${planning}`).toContain(
        type === 'compensation_above_limit'
          ? `(t."id", '${type}', ${DEFAULT_DEADLINE_DAYS[type]}, true)`
          : `(t."id", '${type}', ${DEFAULT_DEADLINE_DAYS[type]})`,
      );
  });

  it('the appeal kinds are their CHECK’s (widened by ADR 0059)', () => {
    expect(
      read(
        'prisma/migrations/20261115090300_board_management_kinds/migration.sql',
      ),
    ).toContain(`"kind" IN (${quoted(BOARD_APPEAL_KINDS)})`);
  });

  it('a complaint’s categories are their CHECK’s', () => {
    expect(
      read(
        'prisma/migrations/20261115090300_board_management_kinds/migration.sql',
      ),
    ).toContain(`"category" IN (${quoted(MANAGEMENT_COMPLAINT_CATEGORIES)})`);
  });

  it('an agenda decline’s codes are its CHECK’s and the mirror’s (ADR 0059)', () => {
    expect(voice).toContain(
      `"decline_reason" IN (${quoted(REASON_CODES.agendaDecline)})`,
    );
    expect(mirror).toContain(
      `agendaDecline: [${quoted(REASON_CODES.agendaDecline)}]`,
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
