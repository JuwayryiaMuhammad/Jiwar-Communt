import type { ManagementRequestStatus } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';

// ============================================================================
// The life of a management request (ADR 0039), as one table.
//
//   open ──► in_progress ──► answered ──► closed
//     ▲           ▲              │           │
//     │           └── the author replies     │
//     └──────── the author reopens (7 days) ─┘
//
// Every write locks the request's row, reads it again and asks this table;
// a request that lost a race is refused with the status it found.
// ============================================================================

/** Days after closing during which the author may reopen. */
export const REOPEN_DAYS = 7;

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type RequestAction =
  /** A message of the author's. */
  | 'message'
  /** A staff message the author reads, official or not. */
  | 'reply'
  /** A staff note: never moves the request. */
  | 'note'
  /** Staff: taken in hand without a message. */
  | 'start'
  | 'assign'
  /** Staff. */
  | 'close'
  /** The author. */
  | 'withdraw'
  /** The author, within REOPEN_DAYS of the close. */
  | 'reopen'
  /** The author, once. */
  | 'rate'
  /** Booking, proposing, confirming or cancelling an appointment. */
  | 'appointment';

const LIVE: readonly ManagementRequestStatus[] = [
  'open',
  'in_progress',
  'answered',
];

export const ALLOWED_FROM: Record<
  RequestAction,
  readonly ManagementRequestStatus[]
> = {
  message: LIVE,
  reply: LIVE,
  // A note is staff's own: also on a closed request.
  note: [...LIVE, 'closed'],
  start: ['open'],
  assign: LIVE,
  close: LIVE,
  withdraw: LIVE,
  reopen: ['closed'],
  rate: ['closed'],
  appointment: LIVE,
};

export const can = (
  request: { status: ManagementRequestStatus },
  action: RequestAction,
): boolean => ALLOWED_FROM[action].includes(request.status);

/** 409 MANAGEMENT_REQUEST_INVALID_TRANSITION with the status found. */
export function assertCan(
  request: { status: ManagementRequestStatus },
  action: RequestAction,
): void {
  if (!can(request, action))
    throw appError.conflict(
      ErrorCode.MANAGEMENT_REQUEST_INVALID_TRANSITION,
      `A ${request.status} request does not take: ${action}`,
      { params: { status: request.status } },
    );
}

/**
 * The status after a message the author reads (never a note):
 * - an official reply answers the request;
 * - any other staff message takes an open request in hand, and leaves an
 *   answered one answered (a follow-up to the answer is not a new one);
 * - the author's message on an answered request puts it back in hand.
 */
export function afterMessage(
  status: ManagementRequestStatus,
  message: { side: 'resident' | 'staff'; official: boolean },
): ManagementRequestStatus {
  if (message.side === 'staff')
    return message.official
      ? 'answered'
      : status === 'open'
        ? 'in_progress'
        : status;
  return status === 'answered' ? 'in_progress' : status;
}

/** `MR-000123`: how a request is named to people. */
export const requestNumber = (n: number) => `MR-${String(n).padStart(6, '0')}`;

/** A cycle's due time: its start plus the topic's target. */
export const responseDueAt = (cycleStartedAt: Date, targetHours: number) =>
  new Date(cycleStartedAt.getTime() + targetHours * HOUR);

/** What "overdue" needs of a request. */
export interface ResponseFacts {
  status: ManagementRequestStatus;
  firstResponseAt: Date | null;
  responseDueAt: Date;
}

/**
 * Overdue, in one place (the sweep, the inbox filter and the views ask
 * here): the cycle's response time has passed and staff have not responded
 * in it. Only a request still waiting can be: answered and closed are not.
 */
export function isOverdue(r: ResponseFacts, now: Date): boolean {
  return (
    (r.status === 'open' || r.status === 'in_progress') &&
    r.firstResponseAt === null &&
    r.responseDueAt.getTime() <= now.getTime()
  );
}

/** The last instant the author may reopen. */
export const reopenUntil = (closedAt: Date) =>
  new Date(closedAt.getTime() + REOPEN_DAYS * DAY);

export const mayReopen = (closedAt: Date, now: Date) =>
  now.getTime() <= reopenUntil(closedAt).getTime();
