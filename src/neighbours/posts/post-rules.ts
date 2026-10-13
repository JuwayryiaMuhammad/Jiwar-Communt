import type {
  NeighbourPostKind,
  NeighbourPostStatus,
  Prisma,
} from '@prisma/client';

// ============================================================================
// The two boards (ADR 0042), as pure rules. A post is on its board while
// it is open and its day has not come; nothing runs to take it down. The
// reader's clock decides, the same way for the list, the post and every
// write that needs a live post.
// ============================================================================

export type Board = 'lost_found' | 'lending';
export const BOARDS: readonly Board[] = ['lost_found', 'lending'];

export const BOARD_KINDS: Record<Board, readonly NeighbourPostKind[]> = {
  lost_found: ['lost', 'found'],
  lending: ['lend', 'borrow'],
};

export const boardOf = (kind: NeighbourPostKind): Board =>
  kind === 'lost' || kind === 'found' ? 'lost_found' : 'lending';

/** What a reader is told a post is: `expired` is read, never written. */
export type PostState = 'open' | 'expired' | 'closed';
export const POST_STATES: readonly PostState[] = ['open', 'expired', 'closed'];

interface PostFacts {
  status: NeighbourPostStatus;
  expiresAt: Date;
}

export function postState(post: PostFacts, now: Date): PostState {
  if (post.status === 'closed') return 'closed';
  return post.expiresAt.getTime() > now.getTime() ? 'open' : 'expired';
}

/** On its board now. */
export const isLive = (post: PostFacts, now: Date): boolean =>
  postState(post, now) === 'open';

/** `postState`, as a query. */
export function stateWhere(
  state: PostState,
  now: Date,
): Prisma.NeighbourPostWhereInput {
  if (state === 'closed') return { status: 'closed' };
  return state === 'open'
    ? { status: 'open', expiresAt: { gt: now } }
    : { status: 'open', expiresAt: { lte: now } };
}

const DAY = 86_400_000;

/** When a post written now leaves its board: the compound's days for it. */
export function expiresAt(
  kind: NeighbourPostKind,
  now: Date,
  days: { lostFoundExpiryDays: number; lendingExpiryDays: number },
): Date {
  const n =
    boardOf(kind) === 'lost_found'
      ? days.lostFoundExpiryDays
      : days.lendingExpiryDays;
  return new Date(now.getTime() + n * DAY);
}

/** Only what was found is held at the office and claimed there. */
export const isClaimable = (kind: NeighbourPostKind): boolean =>
  kind === 'found';

/**
 * A calendar day written `YYYY-MM-DD` that exists and is not after
 * tomorrow by UTC (the compound may be a day ahead of the server), or null.
 */
export function parseDay(text: string, now: Date): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text)
    return null;
  return day.getTime() > now.getTime() + DAY ? null : day;
}
