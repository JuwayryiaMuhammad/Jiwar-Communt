import type { BookingStatus } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';

// ============================================================================
// A booking's status (ADR 0044)
// ============================================================================

/** What takes a place in a slot: capacity, the unit's one booking per slot, closures, reminders. */
export const HOLDING = [
  'pending',
  'confirmed',
] as const satisfies readonly BookingStatus[];

/** What counts towards a unit's quota: a no-show used its place. */
export const COUNTED = [
  ...HOLDING,
  'no_show',
] as const satisfies readonly BookingStatus[];

export type BookingAction =
  'approve' | 'reject' | 'cancel' | 'expire' | 'mark_no_show';

/**
 * Where each action may start. `pending → confirmed | rejected | cancelled`
 * and `confirmed → cancelled | no_show`; rejected, cancelled and no-show
 * bookings take nothing. Pure: asked after the booking's row lock.
 */
export const ALLOWED_FROM: Record<BookingAction, readonly BookingStatus[]> = {
  approve: ['pending'],
  reject: ['pending'],
  cancel: ['pending', 'confirmed'],
  expire: ['pending'],
  mark_no_show: ['confirmed'],
};

export function can(
  booking: { status: BookingStatus },
  action: BookingAction,
): boolean {
  return ALLOWED_FROM[action].includes(booking.status);
}

/** 409 with the status found: the loser of a race learns what won. */
export function assertCan(
  booking: { status: BookingStatus },
  action: BookingAction,
): void {
  if (!can(booking, action))
    throw appError.conflict(
      ErrorCode.BOOKING_INVALID_TRANSITION,
      'The booking does not take this action now',
      { params: { status: booking.status } },
    );
}

export const isHolding = (status: BookingStatus) =>
  (HOLDING as readonly BookingStatus[]).includes(status);
