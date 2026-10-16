import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { addMonths } from './certification.service';
import {
  electionOutcomes,
  electionPhase,
  electionWindowProblems,
} from './election-rules';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8');
const elections = read(
  'prisma/migrations/20261029090400_governance_elections/migration.sql',
).replace(/\s+/g, ' ');
const mirror = read('packages/api/src/reasons.ts');
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('who is elected (ADR 0051)', () => {
  const run = (votes: number[], seats = 3) => {
    const r = electionOutcomes(
      votes.map((v, i) => ({ id: `c${i}`, votes: v })),
      seats,
    );
    return {
      outcomes: votes.map((_, i) => r.outcomes.get(`c${i}`)),
      tied: r.tied,
      remaining: r.remaining,
    };
  };

  it('the first `seats` with a vote; nobody with none', () => {
    expect(run([5, 4, 3, 2])).toEqual({
      outcomes: ['elected', 'elected', 'elected', 'not_elected'],
      tied: [],
      remaining: 0,
    });
    expect(run([2, 0, 1])).toEqual({
      outcomes: ['elected', 'not_elected', 'elected'],
      tied: [],
      remaining: 0,
    });
  });

  it('a tie across the last seat elects those above and leaves the rest to the board', () => {
    expect(run([5, 3, 3, 3, 1])).toEqual({
      outcomes: ['elected', 'tied', 'tied', 'tied', 'not_elected'],
      tied: ['c1', 'c2', 'c3'],
      remaining: 2,
    });
  });

  it('a tie inside the seats is no tie', () => {
    expect(run([4, 4, 2, 1])).toEqual({
      outcomes: ['elected', 'elected', 'elected', 'not_elected'],
      tied: [],
      remaining: 0,
    });
  });
});

describe('an election’s window and phases (ADR 0051)', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const h = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
  const w = (o: number, c: number, vo: number, vc: number) => ({
    nominationsOpenAt: h(o),
    nominationsCloseAt: h(c),
    votingOpensAt: h(vo),
    votingClosesAt: h(vc),
  });

  it('nominations 24 hours to 30 days; voting within 14 days of their close', () => {
    expect(electionWindowProblems(w(0, 24, 24, 48), now)).toEqual([]);
    expect(electionWindowProblems(w(0, 12, 24, 48), now)[0].field).toBe(
      'nominationsCloseAt',
    );
    expect(electionWindowProblems(w(0, 24, 20, 48), now)[0].field).toBe(
      'votingOpensAt',
    );
    expect(
      electionWindowProblems(w(0, 24, 24 + 15 * 24, 24 + 16 * 24), now)[0]
        .field,
    ).toBe('votingOpensAt');
    expect(electionWindowProblems(w(0, 24, 30, 30), now)[0]).toMatchObject({
      field: 'votingClosesAt',
      code: 'ENDS_BEFORE_START',
    });
  });

  it('upcoming, nominating, nominations closed, voting, closed, certified, cancelled', () => {
    const e = {
      nominationsOpenAt: h(1),
      nominationsCloseAt: h(25),
      certifiedAt: null as Date | null,
      cancelReasonCode: null as string | null,
    };
    const c = {
      openedAt: null as Date | null,
      closedAt: null as Date | null,
      closesAt: h(50),
      cancelledAt: null as Date | null,
    };
    expect(electionPhase(e, c, now)).toBe('upcoming');
    expect(electionPhase(e, c, h(2))).toBe('nominating');
    expect(electionPhase(e, c, h(26))).toBe('nominations_closed');
    expect(electionPhase(e, { ...c, openedAt: h(26) }, h(27))).toBe('voting');
    expect(electionPhase(e, { ...c, openedAt: h(26) }, h(50))).toBe('closed');
    expect(electionPhase({ ...e, certifiedAt: h(51) }, c, h(52))).toBe(
      'certified',
    );
    expect(electionPhase({ ...e, cancelReasonCode: 'other' }, c, h(2))).toBe(
      'cancelled',
    );
  });
});

describe('the elections’ lists (ADR 0051)', () => {
  it.each([
    'governanceElectionCancel',
    'governanceCandidateDisqualify',
    'governanceCandidateSystemWithdraw',
    'governanceTieBreak',
  ] as const)('%s matches its CHECK and the dashboards’ mirror', (list) => {
    const q = quoted(REASON_CODES[list]);
    expect(elections).toContain(`IN (${q})`);
    expect(mirror).toContain(`${list}: [${q}]`);
  });

  it('the system’s cancel is its own, with nobody behind it', () => {
    expect(REASON_CODES.governanceElectionSystemCancel).toEqual([
      'no_candidates',
    ]);
    expect(elections).toContain(`"cancel_reason_code" = 'no_candidates'`);
    expect(mirror).toContain(
      `governanceElectionSystemCancel: ['no_candidates']`,
    );
  });
});

describe('a term’s months (ADR 0051)', () => {
  it('calendar months, the month’s last day when the day overflows', () => {
    expect(addMonths(new Date('2026-11-01T10:00:00Z'), 24).toISOString()).toBe(
      '2028-11-01T10:00:00.000Z',
    );
    expect(addMonths(new Date('2027-01-31T10:00:00Z'), 1).toISOString()).toBe(
      '2027-02-28T10:00:00.000Z',
    );
  });
});
