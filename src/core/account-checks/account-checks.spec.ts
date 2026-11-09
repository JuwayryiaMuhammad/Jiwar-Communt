import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../common/reasons';
import { INBOX_TYPES } from '../staff-inbox/staff-inbox';
import { IDLE_DAYS, REVIEW_EVERY_DAYS } from './account-checks';
import { DANGLING_REASONS } from './dangling-accounts.service';

const migrations = join(__dirname, '../../../prisma/migrations');
const read = (name: string) =>
  readFileSync(join(migrations, name, 'migration.sql'), 'utf8').replace(
    /\s+/g,
    ' ',
  );
const checks = read('20270614090300_account_checks');
const reinforcement = read('20270614090400_reinforcement');
const latest = read('20270614090500_field_team_b_checks');
const mirror = readFileSync(
  join(__dirname, '../../../packages/api/src/reasons.ts'),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (l: readonly string[]) => l.map((c) => `'${c}'`).join(', ');

describe('the field team’s part b catalogs and their CHECKs (ADR 0090)', () => {
  it('the reasons a finding is made, and the ranges of the settings', () => {
    expect(checks).toContain(`"reason" IN (${quoted(DANGLING_REASONS)})`);
    expect(checks).toContain(
      `"idle_days" BETWEEN ${IDLE_DAYS.min} AND ${IDLE_DAYS.max}`,
    );
    expect(checks).toContain(
      `"review_every_days" BETWEEN ${REVIEW_EVERY_DAYS.min} AND ${REVIEW_EVERY_DAYS.max}`,
    );
    expect(checks).toContain(`DEFAULT ${IDLE_DAYS.default}`);
    expect(checks).toContain(`DEFAULT ${REVIEW_EVERY_DAYS.default}`);
  });

  it('the reason lists are their CHECKs’ and the dashboards’ mirror', () => {
    expect(checks).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.danglingKeep)})`,
    );
    expect(reinforcement).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.reinforcementDismiss)})`,
    );
    expect(reinforcement).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.reinforcementCancel)})`,
    );
    for (const list of [
      'danglingKeep',
      'reinforcementDismiss',
      'reinforcementCancel',
    ] as const)
      expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });

  it('the inbox CHECKs name every type the inbox knew then, in its order', () => {
    // Up to ADR 0090's last; a later phase states them again (ADR 0092).
    const known = INBOX_TYPES.slice(
      0,
      INBOX_TYPES.indexOf('reinforcement_suggestion') + 1,
    );
    const list = `"type" IN (${quoted(known)}))`;
    expect(latest.split(list)).toHaveLength(3);
  });
});
