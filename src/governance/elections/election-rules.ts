import type { GovernanceContest, GovernanceElection } from '@prisma/client';
import { DAY_MS, HOUR_MS } from '../contests/contest-rules';

export const ELECTION_LIMITS = {
  seats: { min: 3, max: 15 },
  termMonths: { min: 6, max: 60 },
  /** How far ahead nominations may open. */
  nominationsWithinDays: 90,
  nominationsMinHours: 24,
  nominationsMaxDays: 30,
  /** From the close of nominations to the opening of the vote, at most. */
  gapMaxDays: 14,
  candidates: 50,
  statement: 500,
} as const;

/**
 * - upcoming: nominations not open yet;
 * - nominating: owners stand and withdraw;
 * - nominations_closed: the list is drawn up, voting not open yet;
 * - voting: votes are taken;
 * - closed: voting closed (counted once the sweep ran); to be certified;
 * - certified: the next board sits;
 * - cancelled.
 */
export const ELECTION_PHASES = [
  'upcoming',
  'nominating',
  'nominations_closed',
  'voting',
  'closed',
  'certified',
  'cancelled',
] as const;
export type ElectionPhase = (typeof ELECTION_PHASES)[number];

export function electionPhase(
  e: Pick<
    GovernanceElection,
    | 'nominationsOpenAt'
    | 'nominationsCloseAt'
    | 'certifiedAt'
    | 'cancelReasonCode'
  >,
  c: Pick<
    GovernanceContest,
    'openedAt' | 'closedAt' | 'closesAt' | 'cancelledAt'
  >,
  now: Date,
): ElectionPhase {
  if (c.cancelledAt || e.cancelReasonCode) return 'cancelled';
  if (e.certifiedAt) return 'certified';
  if (c.closedAt || now >= c.closesAt) return 'closed';
  if (c.openedAt) return 'voting';
  if (now < e.nominationsOpenAt) return 'upcoming';
  if (now < e.nominationsCloseAt) return 'nominating';
  return 'nominations_closed';
}

export interface ElectionWindow {
  nominationsOpenAt: Date;
  nominationsCloseAt: Date;
  votingOpensAt: Date;
  votingClosesAt: Date;
}

/** What an election's dates say, before anything is read: field errors. */
export function electionWindowProblems(
  w: ElectionWindow,
  now: Date,
): { field: string; code: string; params?: Record<string, number> }[] {
  const L = ELECTION_LIMITS;
  if (
    w.nominationsOpenAt.getTime() >
    now.getTime() + L.nominationsWithinDays * DAY_MS
  )
    return [
      {
        field: 'nominationsOpenAt',
        code: 'INVALID_VALUE',
        params: { maxDays: L.nominationsWithinDays },
      },
    ];
  const nominations =
    w.nominationsCloseAt.getTime() - w.nominationsOpenAt.getTime();
  if (nominations <= 0)
    return [{ field: 'nominationsCloseAt', code: 'ENDS_BEFORE_START' }];
  if (
    nominations < L.nominationsMinHours * HOUR_MS ||
    nominations > L.nominationsMaxDays * DAY_MS
  )
    return [
      {
        field: 'nominationsCloseAt',
        code: 'INVALID_VALUE',
        params: {
          minHours: L.nominationsMinHours,
          maxDays: L.nominationsMaxDays,
        },
      },
    ];
  const gap = w.votingOpensAt.getTime() - w.nominationsCloseAt.getTime();
  if (gap < 0 || gap > L.gapMaxDays * DAY_MS)
    return [
      {
        field: 'votingOpensAt',
        code: 'INVALID_VALUE',
        params: { maxDaysAfterNominations: L.gapMaxDays },
      },
    ];
  const voting = w.votingClosesAt.getTime() - w.votingOpensAt.getTime();
  if (voting <= 0)
    return [{ field: 'votingClosesAt', code: 'ENDS_BEFORE_START' }];
  if (voting < HOUR_MS || voting > 60 * DAY_MS)
    return [
      {
        field: 'votingClosesAt',
        code: 'INVALID_VALUE',
        params: { minHours: 1, maxDays: 60 },
      },
    ];
  return [];
}

export type CandidateOutcome =
  'elected' | 'tied' | 'not_elected' | 'ineligible';

/**
 * Who is elected (ADR 0051): candidates ranked by votes; the first `seats`
 * with at least one vote are elected. A tie across the last seat elects
 * those above it and leaves the tied ones `tied` for the board to resolve:
 * `remaining` seats among them. Nobody with no vote is elected.
 */
export function electionOutcomes(
  candidates: readonly { id: string; votes: number }[],
  seats: number,
): {
  outcomes: Map<string, CandidateOutcome>;
  tied: string[];
  remaining: number;
} {
  const outcomes = new Map<string, CandidateOutcome>();
  const voted = [...candidates]
    .filter((c) => c.votes > 0)
    .sort((a, b) => b.votes - a.votes);
  for (const c of candidates) outcomes.set(c.id, 'not_elected');
  if (voted.length <= seats) {
    for (const c of voted) outcomes.set(c.id, 'elected');
    return { outcomes, tied: [], remaining: 0 };
  }
  const cutoff = voted[seats - 1].votes;
  const above = voted.filter((c) => c.votes > cutoff);
  const at = voted.filter((c) => c.votes === cutoff);
  for (const c of above) outcomes.set(c.id, 'elected');
  if (above.length + at.length <= seats) {
    for (const c of at) outcomes.set(c.id, 'elected');
    return { outcomes, tied: [], remaining: 0 };
  }
  for (const c of at) outcomes.set(c.id, 'tied');
  return {
    outcomes,
    tied: at.map((c) => c.id),
    remaining: seats - above.length,
  };
}
