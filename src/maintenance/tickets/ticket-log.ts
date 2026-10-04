import { Injectable } from '@nestjs/common';
import type {
  Ticket,
  TicketAssignmentType,
  TicketStatus,
} from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Writes a ticket's append-only history (ADR 0032), in the action's
 * transaction. Status changes and assignments are recorded here and not in
 * the audit trail; there is no way to change or remove a row.
 */
@Injectable()
export class TicketLog {
  /** One status change; nothing when the status did not change. */
  async status(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'tenantId'>,
    change: {
      from: TicketStatus | null;
      to: TicketStatus;
      actorId: string | null;
      reasonCode?: string | null;
      cycle: number;
    },
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
  }

  async assignment(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'tenantId'>,
    row: {
      type: TicketAssignmentType;
      fromId: string | null;
      toId: string | null;
      assignedById: string | null;
      reasonCode?: string | null;
      cycle: number;
    },
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
  }
}
