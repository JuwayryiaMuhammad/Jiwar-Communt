import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../common/reasons';
import { COMPENSATION_KINDS } from './compensations.service';
import { CASE_KINDS } from './experience-cases.service';
import { DEFAULT_RULES } from './experience-settings.service';
import { meeting } from './experience-signals.service';
import { SIGNAL_CODES } from './experience-sources';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');
const reasons = read(
  'prisma/migrations/20270406090000_low_rating_reasons/migration.sql',
);
const tables = read(
  'prisma/migrations/20270406090100_experience/migration.sql',
);
const mirror = read('packages/api/src/reasons.ts');

describe('experience and recovery: the closed lists are the CHECKs’ and the mirror’s (ADR 0082)', () => {
  it('a low rating’s reasons, on each of the three ratings', () => {
    expect(
      reasons.split(`IN (${quoted(REASON_CODES.lowRating)})`),
    ).toHaveLength(4);
  });

  it('the signals, the cases’ kinds and outcomes, the compensations’ kinds and refusals', () => {
    expect(tables).toContain(`"code" IN (${quoted(SIGNAL_CODES)})`);
    expect(tables).toContain(`"kind" IN (${quoted(CASE_KINDS)})`);
    expect(tables).toContain(
      `"outcome" IN (${quoted(REASON_CODES.experienceCaseOutcome)})`,
    );
    expect(tables).toContain(`"kind" IN (${quoted(COMPENSATION_KINDS)})`);
    expect(tables).toContain(
      `"reject_reason" IN (${quoted(REASON_CODES.compensationReject)})`,
    );
    expect(tables).toContain(
      `"failure_code" IN (${quoted(REASON_CODES.creditNoteCompensation)})`,
    );
  });

  it('the table’s defaults are the code’s', () => {
    for (const [code, count, days] of [
      ['repeated_low_ratings', 'low_ratings_count', 'low_ratings_days'],
      ['reopened_tickets', 'reopened_count', 'reopened_days'],
      ['repeated_complaints', 'complaints_count', 'complaints_days'],
    ]) {
      const rule = DEFAULT_RULES.find((r) => r.code === code)!;
      expect(tables).toContain(`"${count}" INTEGER DEFAULT ${rule.count}`);
      expect(tables).toContain(
        `"${days}" INTEGER NOT NULL DEFAULT ${rule.days}`,
      );
    }
  });

  it.each([
    'lowRating',
    'experienceCaseOutcome',
    'compensationReject',
  ] as const)('%s is the dashboards’ mirror', (list) => {
    expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});

describe('a rule met (ADR 0082)', () => {
  const at = (n: number) => new Date(Date.UTC(2027, 0, 1, 0, n));

  it('counts a unit’s events and takes the newest as the basis', () => {
    expect(
      meeting(
        [
          { unitId: 'u1', itemId: 'a', at: at(1) },
          { unitId: 'u1', itemId: 'c', at: at(3) },
          { unitId: 'u2', itemId: 'b', at: at(2) },
          { unitId: 'u1', itemId: 'b', at: at(3) },
        ],
        2,
      ),
    ).toEqual([{ unitId: 'u1', basisId: 'c', count: 3 }]);
  });

  it('a unit below the count meets nothing', () => {
    expect(meeting([{ unitId: 'u1', itemId: 'a', at: at(1) }], 2)).toEqual([]);
  });
});
