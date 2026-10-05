import { Injectable } from '@nestjs/common';
import type {
  Ticket,
  TicketAssignmentType,
  TicketStatus,
} from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

export interface StatusChange {
  from: TicketStatus | null;
  to: TicketStatus;
  actorId: string | null;
  /** For `on_hold`, the hold reason. */
  reasonCode?: string | null;
  cycle: number;
}

export interface AssignmentChange {
  type: TicketAssignmentType;
  fromId: string | null;
  toId: string | null;
  assignedById: string | null;
  reasonCode?: string | null;
  cycle: number;
}

/**
 * Told of a ticket's change in the change's own transaction, after its
 * history row: `ticket` is the row as it was **before** the change, locked
 * by the caller. A handler that throws rolls the change back.
 */
export type StatusHandler = (
  tx: TenantTxClient,
  ticket: Ticket,
  change: StatusChange,
) => Promise<void>;
export type AssignmentHandler = (
  tx: TenantTxClient,
  ticket: Ticket,
  change: AssignmentChange,
) => Promise<void>;

/**
 * Writes a ticket's append-only history (ADR 0032), in the action's
 * transaction. Status changes and assignments are recorded here and not in
 * the audit trail; there is no way to change or remove a row.
 *
 * Every status change and assignment of every path (a request, the dispatch
 * engine, a release by a lifecycle hook, a sweep) passes through here, so
 * this is also where the rest of maintenance hears of them (ADR 0034): the
 * SLA clocks and the visits register handlers, like core's lifecycle hooks,
 * and no path can forget them.
 */
@Injectable()
export class TicketLog {
  private readonly statusHandlers: StatusHandler[] = [];
  private readonly assignmentHandlers: AssignmentHandler[] = [];

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  onAssignment(handler: AssignmentHandler): void {
    this.assignmentHandlers.push(handler);
  }

  /** One status change; nothing when the status did not change. */
  async status(
    tx: TenantTxClient,
    ticket: Ticket,
    change: StatusChange,
  ): Promise<void> {
    if (change.from === change.to) return;
    await tx.ticketStatusHistory.create({
      data: {
        id: newId(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        fromStatus: change.from,
        toStatus: change.to,
        actorId: change.actorId,
        reasonCode: change.reasonCode ?? null,
        cycle: change.cycle,
      },
    });
    // One after the other: a transaction is one connection.
    for (const handler of this.statusHandlers)
      await handler(tx, ticket, change);
  }

  async assignment(
    tx: TenantTxClient,
    ticket: Ticket,
    row: AssignmentChange,
  ): Promise<void> {
    await tx.ticketAssignment.create({
      data: {
        id: newId(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        fromId: row.fromId,
        toId: row.toId,
        assignedById: row.assignedById,
        assignmentType: row.type,
        reasonCode: row.reasonCode ?? null,
        cycle: row.cycle,
      },
    });
    for (const handler of this.assignmentHandlers)
      await handler(tx, ticket, row);
  }
}
