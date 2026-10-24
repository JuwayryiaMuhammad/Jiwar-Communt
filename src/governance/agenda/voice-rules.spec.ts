import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVAL_PROGRESS_STATUSES } from '../approvals/approval-rules';
import { AGENDA_STATUSES } from './agenda.service';

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261115090500_governance_voice/migration.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (list: readonly string[]) =>
  list.map((v) => `'${v}'`).join(', ');

describe('the owners’ voice: its lists are its CHECKs’ (ADR 0059)', () => {
  it('an agenda proposal’s statuses', () => {
    expect(sql).toContain(`"status" IN (${quoted(AGENDA_STATUSES)})`);
  });

  it('a follow-up’s statuses, the last two final', () => {
    expect(sql).toContain(
      `"status" IN (${quoted(APPROVAL_PROGRESS_STATUSES)})`,
    );
    expect(sql).toContain(
      `WHERE "status" IN ('implemented', 'cannot_implement')`,
    );
  });
});
