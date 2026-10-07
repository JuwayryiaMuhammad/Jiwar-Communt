import type { SlaClock, TicketHoldReason, TicketStatus } from '@prisma/client';
import { can } from './ticket-rules';

// ============================================================================
// Resident escalation (ADR 0038)
// ============================================================================
//
// Whether a resident may ask for attention on a ticket, as one pure
// function: the endpoint runs it under the ticket's lock, and the views run
// it to say `canEscalate`, so the app never rebuilds the rules (it cannot
// know the last one).

export interface EscalationFacts {
  status: TicketStatus;
  holdReason: TicketHoldReason | null;
  /** The late, unmet clocks of the current SLA cycle; empty while the SLA is off. */
  overdue: readonly SlaClock[];
  /** An escalation already exists in the current SLA cycle. */
  escalated: boolean;
  /** The caller has `tickets` on the ticket's unit now (ADR 0032). */
  mayAct: boolean;
}

export type EscalationRefusal =
  'not_allowed' | 'status' | 'not_overdue' | 'already_escalated';

/**
 * Why not, or null. In the order the endpoint answers: who, then the
 * ticket's state, then the time, then "once".
 *
 * A ticket waiting for the residents themselves (`awaiting_resident`) is
 * not escalated: the next move is theirs. Waiting for parts, or on hold
 * for another reason, may be.
 */
export function escalationRefusal(
  f: EscalationFacts,
): EscalationRefusal | null {
  if (!f.mayAct) return 'not_allowed';
  if (!can(f.status, 'escalate')) return 'status';
  if (f.status === 'on_hold' && f.holdReason === 'awaiting_resident')
    return 'status';
  if (!f.overdue.length) return 'not_overdue';
  if (f.escalated) return 'already_escalated';
  return null;
}
