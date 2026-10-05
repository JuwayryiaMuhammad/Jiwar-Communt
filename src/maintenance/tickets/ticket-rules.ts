import type { TicketStatus } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';

// ============================================================================
// Ticket rules (ADR 0032)
// ============================================================================
//
// Which status allows which action, as one table, so every service checks
// the same thing under the ticket's row lock. A request that loses a race
// re-reads the row after the lock and fails here, before writing anything.

export type TicketAction =
  | 'assign'
  | 'reassign'
  | 'start'
  | 'hold'
  | 'resume'
  | 'complete'
  | 'decline'
  | 'release'
  | 'cancelByReporter'
  | 'cancelByDispatcher'
  | 'confirm'
  | 'reject'
  | 'reopen'
  | 'autoClose'
  | 'changePriority'
  | 'changeCategory'
  | 'visit'
  | 'message'
  | 'reportPhoto'
  | 'workPhoto';

/** Work in a technician's hands. */
export const IN_HAND: readonly TicketStatus[] = [
  'assigned',
  'in_progress',
  'on_hold',
];

const OPEN: readonly TicketStatus[] = ['new', ...IN_HAND];

export const ALLOWED_FROM: Record<TicketAction, readonly TicketStatus[]> = {
  assign: ['new'],
  reassign: IN_HAND,
  start: ['assigned'],
  hold: ['in_progress'],
  resume: ['on_hold'],
  complete: ['in_progress'],
  // Before the work starts; after, the dispatcher reassigns.
  decline: ['assigned'],
  release: IN_HAND,
  cancelByReporter: ['new', 'assigned'],
  // Any time before it is closed.
  cancelByDispatcher: [...OPEN, 'completed'],
  confirm: ['completed'],
  reject: ['completed'],
  reopen: ['closed'],
  autoClose: ['completed'],
  changePriority: [...OPEN, 'completed'],
  // ADR 0034: like the priority; the technician keeps the ticket.
  changeCategory: [...OPEN, 'completed'],
  // ADR 0034: a visit is arranged, changed and made while a technician
  // holds the ticket.
  visit: IN_HAND,
  message: [...OPEN, 'completed'],
  reportPhoto: OPEN,
  workPhoto: ['in_progress', 'on_hold'],
};

export function can(status: TicketStatus, action: TicketAction): boolean {
  return ALLOWED_FROM[action].includes(status);
}

/** TICKET_INVALID_TRANSITION (409) unless the status allows the action. */
export function assertCan(
  ticket: { status: TicketStatus },
  action: TicketAction,
): void {
  if (!can(ticket.status, action))
    throw appError.conflict(
      ErrorCode.TICKET_INVALID_TRANSITION,
      `A ${ticket.status} ticket does not allow ${action}`,
      { params: { status: ticket.status } },
    );
}

/**
 * Where a rejected or reopened ticket goes. The first time (no earlier
 * rejection or reopen) it goes back to the technician who did the work, if
 * they can still take it; otherwise, and every later time, back to the
 * dispatch queue as an escalation.
 */
export function afterRejection(input: {
  rejectionCount: number;
  technicianId: string | null;
  technicianAvailable: boolean;
}):
  | { status: 'assigned'; technicianId: string; escalated: false }
  | { status: 'new'; technicianId: null; escalated: boolean } {
  if (
    input.rejectionCount === 0 &&
    input.technicianId &&
    input.technicianAvailable
  )
    return {
      status: 'assigned',
      technicianId: input.technicianId,
      escalated: false,
    };
  return {
    status: 'new',
    technicianId: null,
    escalated: input.rejectionCount > 0,
  };
}

/** `MT-000123`: the compound's own ticket number, as people say it. */
export function ticketNumber(n: number): string {
  return `MT-${String(n).padStart(6, '0')}`;
}
