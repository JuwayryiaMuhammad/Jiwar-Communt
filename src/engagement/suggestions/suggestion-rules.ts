import type { SuggestionStatus } from '@prisma/client';

// ============================================================================
// A suggestion's way (ADR 0040, 0080): received → under_review → planned →
// done, or declined from any step before the end. It moves forward only,
// but for `deferred` (ADR 0080): "not now", which any step before the end
// may come to and which may go on to any of them later. The two ends are
// final: what the staff told the resident stands. Done, deferred and
// declined are each answered: the resident is told why.
// ============================================================================

const NEXT: Record<SuggestionStatus, readonly SuggestionStatus[]> = {
  received: ['under_review', 'planned', 'deferred', 'done', 'declined'],
  under_review: ['planned', 'deferred', 'done', 'declined'],
  planned: ['deferred', 'done', 'declined'],
  deferred: ['under_review', 'planned', 'done', 'declined'],
  done: [],
  declined: [],
};

export const nextStatuses = (from: SuggestionStatus) => NEXT[from];

export const canMove = (from: SuggestionStatus, to: SuggestionStatus) =>
  NEXT[from].includes(to);

/** Done, deferred and declined are answered (ADR 0080; a decline since 0040). */
export const needsResponse = (to: SuggestionStatus) =>
  to === 'done' || to === 'deferred' || to === 'declined';

/** The limits the DTOs and the CHECK suggestions_lengths share. */
export const SUGGESTION_BODY = { min: 1, max: 2000 } as const;
export const RESPONSE_MAX = 2000;
export const PUBLIC_TITLE_MAX = 150;
export const PUBLIC_TEXT_MAX = 2000;
export const DONE_NOTE_MAX = 2000;
