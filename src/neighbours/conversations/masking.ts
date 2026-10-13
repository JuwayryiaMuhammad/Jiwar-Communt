import { firstNameOf } from '../../core/common/http/personal';

// ============================================================================
// What one side of a masked conversation is shown of the other (ADR 0042),
// as pure rules. Before both agree: the building the other wrote from, and
// nothing else. After: a first name as well. Never a full name, a phone,
// an email, a unit or an account id; no view has a field for any of them.
// ============================================================================

export type ConversationSide = 'author' | 'responder';

interface Parties {
  authorId: string;
  responderId: string;
}

interface Consents {
  authorRevealAt: Date | null;
  responderRevealAt: Date | null;
}

/** Which side `accountId` is on, or null: not a participant. */
export function sideOf(c: Parties, accountId: string): ConversationSide | null {
  if (c.authorId === accountId) return 'author';
  return c.responderId === accountId ? 'responder' : null;
}

export const otherSide = (side: ConversationSide): ConversationSide =>
  side === 'author' ? 'responder' : 'author';

export const otherOf = (c: Parties, side: ConversationSide): string =>
  side === 'author' ? c.responderId : c.authorId;

/** Whether this side has agreed to show names. */
export const agreed = (c: Consents, side: ConversationSide): boolean =>
  (side === 'author' ? c.authorRevealAt : c.responderRevealAt) !== null;

/** Names show when both have agreed, and only then. */
export const namesRevealed = (c: Consents): boolean =>
  c.authorRevealAt !== null && c.responderRevealAt !== null;

/** The other side, as this side is shown it. */
export interface MaskedParty {
  /** The building they wrote from; null when their unit names none. */
  building: string | null;
  /** Their first name, once both agreed; null before, and for an erased account. */
  firstName: string | null;
}

export function masked(
  c: Consents,
  other: {
    building: string | null;
    fullName: string | null;
    status: string;
  },
): MaskedParty {
  return {
    building: other.building,
    firstName:
      namesRevealed(c) && other.status !== 'erased'
        ? firstNameOf(other.fullName)
        : null,
  };
}
