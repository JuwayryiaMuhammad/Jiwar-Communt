import type { SuggestionStatus } from '@prisma/client';

// ============================================================================
// A suggestion's way (ADR 0040): received → under_review → planned → done,
// or declined from any step before the end. It only moves forward, and the
// two ends are final: what the staff told the resident stands.
// ============================================================================

const NEXT: Record<SuggestionStatus, readonly SuggestionStatus[]> = {
  received: ['under_review', 'planned', 'done', 'declined'],
  under_review: ['planned', 'done', 'declined'],
  planned: ['done', 'declined'],
  done: [],
  declined: [],
};

export const nextStatuses = (from: SuggestionStatus) => NEXT[from];

export const canMove = (from: SuggestionStatus, to: SuggestionStatus) =>
  NEXT[from].includes(to);

/** Declining is answered: the resident is told why. */
export const needsResponse = (to: SuggestionStatus) => to === 'declined';

/** The limits the DTOs and the CHECK suggestions_lengths share. */
export const SUGGESTION_BODY = { min: 1, max: 2000 } as const;
export const RESPONSE_MAX = 2000;
export const PUBLIC_TITLE_MAX = 150;
export const PUBLIC_TEXT_MAX = 2000;
export const DONE_NOTE_MAX = 2000;
