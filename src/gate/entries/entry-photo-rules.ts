import type { GateSubjectType } from '@prisma/client';

/** Whose `in` may carry the guard's photo (ADR 0056): visitors only. */
export const VISITOR_PHOTO_SUBJECTS: readonly GateSubjectType[] = [
  'visitor_pass',
  'gate_request',
  'field_exception',
];

/** How long a visitor's photo is kept after the entry, unless an incident keeps it. */
export const VISITOR_PHOTO_DAYS = 30;

/** When a photo taken at an entry at `enteredAt` is deleted. */
export function photoPurgeAfter(enteredAt: Date): Date {
  return new Date(enteredAt.getTime() + VISITOR_PHOTO_DAYS * 86_400_000);
}
