import type { GovernanceContest } from '@prisma/client';

// ============================================================================
// A contest's life and its limits (ADR 0051), as pure functions of the row
// and the database's clock.
// ============================================================================

/**
 * - scheduled: not open yet (its electorate not taken);
 * - open: votes are taken;
 * - closed: its closing time passed (its result once the sweep counted it);
 * - cancelled: ended with no result.
 */
export const CONTEST_STATUSES = [
  'scheduled',
  'open',
  'closed',
  'cancelled',
] as const;
export type ContestStatus = (typeof CONTEST_STATUSES)[number];

type Dates = Pick<
  GovernanceContest,
  'opensAt' | 'closesAt' | 'openedAt' | 'closedAt' | 'cancelledAt'
>;

/**
 * Closed from its closing time on, whether the sweep counted it yet or not:
 * a vote a second late is refused by the clock, not by the sweep's timing.
 * Open only once its electorate was taken.
 */
export function contestStatus(c: Dates, now: Date): ContestStatus {
  if (c.cancelledAt) return 'cancelled';
  if (c.closedAt || now >= c.closesAt) return 'closed';
  return c.openedAt ? 'open' : 'scheduled';
}

/** The contests in a status at `now`, as a Prisma filter on the contest. */
export function contestStatusWhere(status: ContestStatus, now: Date) {
  switch (status) {
    case 'cancelled':
      return { cancelledAt: { not: null } };
    case 'closed':
      return {
        cancelledAt: null,
        OR: [{ closedAt: { not: null } }, { closesAt: { lte: now } }],
      };
    case 'scheduled':
      return {
        cancelledAt: null,
        closedAt: null,
        openedAt: null,
        closesAt: { gt: now },
      };
    case 'open':
      return {
        cancelledAt: null,
        closedAt: null,
        openedAt: { not: null },
        closesAt: { gt: now },
      };
  }
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const CONTEST_LIMITS = {
  /** Polls and elections not yet closed or cancelled, per compound. */
  live: 10,
  /** How far ahead a contest may open. */
  opensWithinDays: 90,
  /** How long voting lasts. */
  minHours: 1,
  maxDays: 60,
  /** The reminder before voting closes. */
  reminderLeadMs: 24 * HOUR_MS,
} as const;

/** What a contest's window says, before anything is read: field errors. */
export function windowProblems(
  opensAt: Date,
  closesAt: Date,
  now: Date,
): { field: string; code: string; params?: Record<string, number> }[] {
  if (
    opensAt.getTime() >
    now.getTime() + CONTEST_LIMITS.opensWithinDays * DAY_MS
  )
    return [
      {
        field: 'opensAt',
        code: 'INVALID_VALUE',
        params: { maxDays: CONTEST_LIMITS.opensWithinDays },
      },
    ];
  if (closesAt <= opensAt)
    return [{ field: 'closesAt', code: 'ENDS_BEFORE_START' }];
  const length = closesAt.getTime() - opensAt.getTime();
  if (
    length < CONTEST_LIMITS.minHours * HOUR_MS ||
    length > CONTEST_LIMITS.maxDays * DAY_MS
  )
    return [
      {
        field: 'closesAt',
        code: 'INVALID_VALUE',
        params: {
          minHours: CONTEST_LIMITS.minHours,
          maxDays: CONTEST_LIMITS.maxDays,
        },
      },
    ];
  return [];
}
