import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { contestStatus, windowProblems } from '../contests/contest-rules';
import { pollResult, type Tally } from './poll-rules';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8');
const polls = read(
  'prisma/migrations/20261029090300_governance_polls/migration.sql',
).replace(/\s+/g, ' ');
const mirror = read('packages/api/src/reasons.ts');
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('a poll’s result (ADR 0051)', () => {
  const yesNo = (
    yes: number,
    no: number,
    abstain: number,
    over: Partial<Tally> = {},
  ) =>
    pollResult({
      kind: 'yes_no',
      electorate: 10,
      turnout: yes + no + abstain,
      quorumPct: 50,
      thresholdPct: 50,
      options: [
        { id: 'y', key: 'yes', votes: yes },
        { id: 'n', key: 'no', votes: no },
        { id: 'a', key: 'abstain', votes: abstain },
      ],
      ...over,
    }).result;

  it('the quorum counts abstentions; short of it, nothing passes', () => {
    expect(yesNo(1, 0, 4)).toBe('passed'); // 5 of 10 voted: the quorum
    expect(yesNo(4, 0, 0)).toBe('no_quorum'); // 4 of 10
    expect(yesNo(0, 0, 0, { electorate: 0 })).toBe('no_quorum');
  });

  it('yes needs the threshold of yes + no, and more than no: a tie fails', () => {
    expect(yesNo(3, 3, 0)).toBe('failed');
    expect(yesNo(4, 2, 0, { thresholdPct: 67 })).toBe('failed'); // 66.6 %
    expect(yesNo(4, 2, 0, { thresholdPct: 66 })).toBe('passed');
    expect(yesNo(5, 0, 0, { thresholdPct: 100 })).toBe('passed');
    expect(yesNo(5, 1, 0, { thresholdPct: 100 })).toBe('failed');
  });

  it('one of several: strictly first with the threshold of all votes; a tie at the top is tied', () => {
    const choice = (votes: number[], thresholdPct = 50) =>
      pollResult({
        kind: 'choice',
        electorate: 10,
        turnout: votes.reduce((a, b) => a + b, 0),
        quorumPct: 10,
        thresholdPct,
        options: votes.map((v, i) => ({ id: `o${i}`, key: null, votes: v })),
      });
    expect(choice([3, 3, 1])).toEqual({
      result: 'tied',
      winningOptionId: null,
    });
    expect(choice([4, 2, 1])).toEqual({
      result: 'passed',
      winningOptionId: 'o0',
    });
    // 4 of 8 is 50 % exactly: it carries at 50, not at 51.
    expect(choice([1, 4, 3])).toEqual({
      result: 'passed',
      winningOptionId: 'o1',
    });
    expect(choice([1, 4, 3], 51).result).toBe('failed');
    expect(choice([0, 0], 50).result).toBe('no_quorum');
  });
});

describe('a contest’s window and status (ADR 0051)', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const h = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

  it('opens within 90 days, lasts 1 hour to 60 days', () => {
    expect(windowProblems(now, h(1), now)).toEqual([]);
    expect(windowProblems(now, h(0.5), now)[0]).toMatchObject({
      field: 'closesAt',
      code: 'INVALID_VALUE',
    });
    expect(windowProblems(now, h(-1), now)[0]).toMatchObject({
      field: 'closesAt',
      code: 'ENDS_BEFORE_START',
    });
    expect(windowProblems(now, h(24 * 61), now)[0].field).toBe('closesAt');
    expect(windowProblems(h(24 * 91), h(24 * 92), now)[0].field).toBe(
      'opensAt',
    );
  });

  it('open only once its electorate was taken; closed from its closing time on', () => {
    const c = {
      opensAt: h(-1),
      closesAt: h(1),
      openedAt: null as Date | null,
      closedAt: null,
      cancelledAt: null,
    };
    expect(contestStatus(c, now)).toBe('scheduled');
    expect(contestStatus({ ...c, openedAt: h(-1) }, now)).toBe('open');
    expect(contestStatus({ ...c, openedAt: h(-1) }, h(1))).toBe('closed');
    expect(contestStatus({ ...c, cancelledAt: now }, now)).toBe('cancelled');
  });
});

describe('the polls’ lists (ADR 0051)', () => {
  it('governancePollCancel matches its CHECK and the dashboards’ mirror', () => {
    const q = quoted(REASON_CODES.governancePollCancel);
    expect(polls).toContain(`IN (${q})`);
    expect(mirror).toContain(`governancePollCancel: [${q}]`);
  });
});
