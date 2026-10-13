import type { Poll } from '@prisma/client';

// ============================================================================
// A poll's life and what may be seen of it (ADR 0040), as pure functions of
// the row and the database's clock.
// ============================================================================

/**
 * - scheduled: its opening is ahead;
 * - open: votes are taken;
 * - closed: its closing time has passed, or the staff closed it early;
 * - cancelled: ended with no result.
 */
export type PollStatus = 'scheduled' | 'open' | 'closed' | 'cancelled';
export const POLL_STATUSES = [
  'scheduled',
  'open',
  'closed',
  'cancelled',
] as const satisfies readonly PollStatus[];

type Dates = Pick<Poll, 'opensAt' | 'closesAt' | 'closedAt' | 'cancelledAt'>;

/**
 * Closed from its closing time on, whether or not the sweep has written
 * the final counts yet: a vote a second late is refused by the clock, not
 * by the sweep's timing.
 */
export function pollStatus(p: Dates, now: Date): PollStatus {
  if (p.cancelledAt) return 'cancelled';
  if (p.closedAt || now >= p.closesAt) return 'closed';
  return now < p.opensAt ? 'scheduled' : 'open';
}

export function pollStatusWhere(status: PollStatus, now: Date) {
  switch (status) {
    case 'cancelled':
      return { cancelledAt: { not: null } };
    case 'closed':
      return {
        cancelledAt: null,
        OR: [{ closedAt: { not: null } }, { closesAt: { lte: now } }],
      };
    case 'scheduled':
      return { cancelledAt: null, closedAt: null, opensAt: { gt: now } };
    case 'open':
      return {
        cancelledAt: null,
        closedAt: null,
        opensAt: { lte: now },
        closesAt: { gt: now },
      };
  }
}

/**
 * Below this many units, an open poll's counts and turnout are shown to
 * nobody: with so few ballots a count says who chose what.
 */
export const RESULTS_MIN_TURNOUT = 5;

/** Why results are withheld, when they are. */
export type ResultsHidden =
  'not_open' | 'not_voted' | 'few_votes' | 'cancelled' | null;

/**
 * Whether a reader sees a poll's counts now:
 *
 * - cancelled: never; not opened yet: nothing to see;
 * - closed: everyone, in full, whatever the turnout;
 * - open: the staff, and a resident one of whose units has voted, once at
 *   least RESULTS_MIN_TURNOUT units have voted.
 */
export function resultsHidden(
  status: PollStatus,
  reader: 'staff' | { voted: boolean },
  turnout: number,
): ResultsHidden {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'scheduled') return 'not_open';
  if (status === 'closed') return null;
  if (reader !== 'staff' && !reader.voted) return 'not_voted';
  return turnout < RESULTS_MIN_TURNOUT ? 'few_votes' : null;
}

/** The limits the DTOs and the CHECKs share. */
export const QUESTION_MAX = 500;
export const OPTION_LABEL_MAX = 200;
export const OPTIONS = { min: 2, max: 10 } as const;

/**
 * A choice, checked against the poll: one option of it (or at least one,
 * when several may be chosen), each once. Returns the problem as an index
 * into `optionIds`, `-1` for the list as a whole, or null when it stands.
 */
export function choiceProblem(
  optionIds: readonly string[],
  pollOptionIds: readonly string[],
  multiple: boolean,
): { index: number; max: number } | null {
  const max = multiple ? pollOptionIds.length : 1;
  if (
    optionIds.length < 1 ||
    optionIds.length > max ||
    new Set(optionIds).size !== optionIds.length
  )
    return { index: -1, max };
  const index = optionIds.findIndex((id) => !pollOptionIds.includes(id));
  return index === -1 ? null : { index, max };
}
