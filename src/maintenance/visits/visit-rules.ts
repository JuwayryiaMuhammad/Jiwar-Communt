import type { VisitSide, VisitStatus } from '@prisma/client';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';

// ============================================================================
// Visit rules (ADR 0034)
// ============================================================================
//
// What a visit's status allows, and what a window must be, as pure
// functions: the services check them under the ticket's row lock with the
// database's clock read after the lock.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A window starts at least this long from now… */
export const MIN_LEAD_MS = 15 * MINUTE;
/** …and within this long. */
export const MAX_AHEAD_MS = 30 * DAY;
/** A window lasts at most this long (also a CHECK). */
export const MAX_LENGTH_MS = 4 * HOUR;
/** The technician may mark the arrival from this long before the start… */
export const ARRIVE_EARLY_MS = 30 * MINUTE;
/** …until this long after the end. */
export const ARRIVE_LATE_MS = 2 * HOUR;
/** A confirmed visit not arrived this long after its start is late. */
export const LATE_AFTER_MS = 15 * MINUTE;

/** Proposed, confirmed or arrived: at most one per ticket. */
export const ACTIVE: readonly VisitStatus[] = [
  'proposed',
  'confirmed',
  'arrived',
];

export type VisitAction =
  | 'confirm'
  | 'counter'
  | 'reschedule'
  | 'cancel'
  | 'arrive'
  | 'done'
  | 'noAccess'
  | 'grantConsent'
  | 'revokeConsent'
  | 'setReceiver';

export const VISIT_ALLOWED_FROM: Record<VisitAction, readonly VisitStatus[]> = {
  // The other side's proposal.
  confirm: ['proposed'],
  counter: ['proposed'],
  // A confirmed window, moved: a new proposal.
  reschedule: ['confirmed'],
  cancel: ['proposed', 'confirmed'],
  arrive: ['confirmed'],
  done: ['arrived'],
  noAccess: ['arrived'],
  // Consent and the receiver: on a confirmed visit, until the arrival.
  grantConsent: ['confirmed'],
  revokeConsent: ['confirmed'],
  setReceiver: ['confirmed'],
};

export function canVisit(status: VisitStatus, action: VisitAction): boolean {
  return VISIT_ALLOWED_FROM[action].includes(status);
}

/** VISIT_INVALID_TRANSITION (409) unless the status allows the action. */
export function assertVisit(
  visit: { status: VisitStatus },
  action: VisitAction,
): void {
  if (!canVisit(visit.status, action))
    throw appError.conflict(
      ErrorCode.VISIT_INVALID_TRANSITION,
      `A ${visit.status} visit does not allow ${action}`,
      { params: { status: visit.status } },
    );
}

/** The other side answers a proposal: VISIT_SAME_SIDE (403) otherwise. */
export function assertOtherSide(
  visit: { proposedBySide: VisitSide },
  side: VisitSide,
): void {
  if (visit.proposedBySide === side)
    throw appError.forbidden(
      ErrorCode.VISIT_SAME_SIDE,
      'The other side answers a proposal',
    );
}

/** The field errors of a window, as of the database's `now` (none: valid). */
export function windowErrors(
  startsAt: Date,
  endsAt: Date,
  now: Date,
): FieldError[] {
  const errors: FieldError[] = [];
  const lead = startsAt.getTime() - now.getTime();
  if (lead < MIN_LEAD_MS)
    errors.push({
      field: 'startsAt',
      code: FieldErrorCode.VISIT_TOO_SOON,
      params: { minutes: MIN_LEAD_MS / MINUTE },
    });
  else if (lead > MAX_AHEAD_MS)
    errors.push({
      field: 'startsAt',
      code: FieldErrorCode.VISIT_TOO_FAR,
      params: { days: MAX_AHEAD_MS / DAY },
    });
  const length = endsAt.getTime() - startsAt.getTime();
  if (length <= 0)
    errors.push({
      field: 'endsAt',
      code: FieldErrorCode.VISIT_ENDS_BEFORE_START,
    });
  else if (length > MAX_LENGTH_MS)
    errors.push({
      field: 'endsAt',
      code: FieldErrorCode.VISIT_TOO_LONG,
      params: { hours: MAX_LENGTH_MS / HOUR },
    });
  return errors;
}

/** VALIDATION_FAILED (400) unless the window is valid as of `now`. */
export function assertWindow(startsAt: Date, endsAt: Date, now: Date): void {
  const fields = windowErrors(startsAt, endsAt, now);
  if (fields.length)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid window', {
      fields,
    });
}

/** Whether `now` lets the technician mark the arrival. */
export function inArrivalWindow(
  visit: { startsAt: Date; endsAt: Date },
  now: Date,
): boolean {
  const t = now.getTime();
  return (
    t >= visit.startsAt.getTime() - ARRIVE_EARLY_MS &&
    t <= visit.endsAt.getTime() + ARRIVE_LATE_MS
  );
}
