import type { NeighbourComplaintStatus, NeighbourThread } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';

// ============================================================================
// The life of a complaint against a unit (ADR 0042), as one table.
//
//   submitted ──► under_review ──► notice_sent ◄──► mediation
//       │              │               │               │
//       └──────────────┴───────┬───────┴───────────────┘
//                              ▼
//                     resolved | dismissed
//
// Every write locks the complaint's row, reads it again and asks this
// table; a write that lost a race is refused with the status it found.
// ============================================================================

export type ComplaintAction =
  /** Staff: taken in hand. */
  | 'review'
  /** Staff: the one notice to the unit complained about. */
  | 'notice'
  /** Staff: the two sides are being brought to an arrangement. */
  | 'mediate'
  /** Staff, with a reason code. */
  | 'resolve'
  /** Staff, with a reason code (`unfounded` among them). */
  | 'dismiss'
  /** The author, before the unit has been told anything. */
  | 'withdraw'
  /** A message in the complainant's thread, from either side. */
  | 'message'
  /** A message in the unit's thread, from either side. */
  | 'target_message'
  /** A staff note: never moves the complaint. */
  | 'note';

export const OPEN_STATUSES: readonly NeighbourComplaintStatus[] = [
  'submitted',
  'under_review',
  'notice_sent',
  'mediation',
];

const ALL: readonly NeighbourComplaintStatus[] = [
  ...OPEN_STATUSES,
  'resolved',
  'dismissed',
];

export const ALLOWED_FROM: Record<
  ComplaintAction,
  readonly NeighbourComplaintStatus[]
> = {
  review: ['submitted'],
  // Whether one was already sent is the notice's own rule, not a status.
  notice: ['under_review', 'mediation'],
  mediate: ['under_review', 'notice_sent'],
  resolve: ['under_review', 'notice_sent', 'mediation'],
  dismiss: OPEN_STATUSES,
  // Once the unit has been told, only the staff end it.
  withdraw: ['submitted', 'under_review'],
  message: OPEN_STATUSES,
  target_message: OPEN_STATUSES,
  // A note is the staff's own: also on a closed complaint.
  note: ALL,
};

export const isOpen = (status: NeighbourComplaintStatus): boolean =>
  OPEN_STATUSES.includes(status);

export const can = (
  complaint: { status: NeighbourComplaintStatus },
  action: ComplaintAction,
): boolean => ALLOWED_FROM[action].includes(complaint.status);

/** 409 NEIGHBOUR_COMPLAINT_INVALID_TRANSITION with the status found. */
export function assertCan(
  complaint: { status: NeighbourComplaintStatus },
  action: ComplaintAction,
): void {
  if (!can(complaint, action))
    throw appError.conflict(
      ErrorCode.NEIGHBOUR_COMPLAINT_INVALID_TRANSITION,
      `A ${complaint.status} complaint does not take: ${action}`,
      { params: { status: complaint.status } },
    );
}

/**
 * The status after the notice went out: a complaint under review is now
 * `notice_sent`; one in mediation stays in mediation.
 */
export const afterNotice = (
  status: NeighbourComplaintStatus,
): NeighbourComplaintStatus =>
  status === 'under_review' ? 'notice_sent' : status;

/** What posting in a thread asks of the table. */
export const postAction = (thread: NeighbourThread): ComplaintAction =>
  thread === 'internal'
    ? 'note'
    : thread === 'target'
      ? 'target_message'
      : 'message';

/** `NC-000123`: how a complaint is named to its author and to the staff. */
export const complaintNumber = (n: number) =>
  `NC-${String(n).padStart(6, '0')}`;
