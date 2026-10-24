import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  DECISION_APPEAL_EFFECT_REASONS,
  DECISION_APPEAL_KINDS,
  decisionAppealReference,
} from './appeal-rules';

const migrations = join(__dirname, '../../../prisma/migrations');
const read = (name: string) =>
  readFileSync(join(migrations, name, 'migration.sql'), 'utf8').replace(
    /\s+/g,
    ' ',
  );
const quoted = (list: readonly string[]) =>
  list.map((v) => `'${v}'`).join(', ');

describe('decision appeal rules (ADR 0059)', () => {
  const appeals = read('20261115090100_decision_appeals');
  const subjects = read('20261115090200_decision_appeal_subjects');

  it('keeps the kinds in step with the database', () => {
    expect(appeals).toContain(
      `CHECK ("kind" IN (${quoted(DECISION_APPEAL_KINDS)}))`,
    );
  });

  it('keeps the effect reasons in step with the database', () => {
    expect(appeals).toContain(
      `"effect_reason" IN ( ${quoted(DECISION_APPEAL_EFFECT_REASONS)}))`,
    );
  });

  it('keeps a worker’s reject codes in step with the database', () => {
    expect(subjects).toContain(
      `"reject_reason" IN (${quoted([...REASON_CODES.workerReject, 'underage'])})`,
    );
  });

  it('numbers appeals AP- with six digits', () => {
    expect(decisionAppealReference(7)).toBe('AP-000007');
    expect(decisionAppealReference(123456)).toBe('AP-123456');
  });
});
