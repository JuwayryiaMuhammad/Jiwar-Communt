import { Injectable } from '@nestjs/common';
import type { TicketPriority } from '@prisma/client';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { ticketNumber } from './tickets/ticket-rules';
import { TicketsService } from './tickets/tickets.service';
import { WorkOrdersService } from './tickets/work-orders.service';

/** A ticket a management request became. */
export interface ConvertedTicket {
  id: string;
  number: number;
  /** `MT-000123`. */
  reference: string;
}

/**
 * What the management opens in maintenance (ADR 0080): a request turned
 * into a ticket, in the management's transaction, through the ticket
 * service's own paths and checks — a resident's ticket on their behalf
 * (ADR 0032), or the management's own work order on a common area or an
 * asset (ADR 0076). The caller dispatches it once its transaction has
 * committed. Management imports maintenance only through its index
 * (ADR 0015); maintenance never imports management.
 */
@Injectable()
export class MaintenanceManagementPort {
  constructor(
    private readonly tickets: TicketsService,
    private readonly workOrders: WorkOrdersService,
  ) {}

  /** A resident's ticket in their unit, they its reporter (REPORTER_NOT_ELIGIBLE). */
  async openForResident(
    tx: TenantTxClient,
    id: string,
    input: {
      reporterAccountId: string;
      unitId: string;
      categoryId: string;
      priority?: TicketPriority;
      description: string;
    },
  ): Promise<ConvertedTicket> {
    const t = await this.tickets.openOnBehalfIn(
      tx,
      id,
      input,
      'management_request',
    );
    return { id: t.id, number: t.number, reference: ticketNumber(t.number) };
  }

  /** The management's own work order on a common area or an asset. */
  async openWorkOrder(
    tx: TenantTxClient,
    id: string,
    input: {
      assetId?: string;
      commonAreaId?: string;
      categoryId: string;
      priority?: TicketPriority;
      description: string;
    },
  ): Promise<ConvertedTicket> {
    const t = await this.workOrders.openIn(tx, id, input);
    return { id: t.id, number: t.number, reference: ticketNumber(t.number) };
  }

  /** After the caller's commit: the dispatch engine tries the new ticket. */
  dispatchAfterCommit(ticketId: string): Promise<void> {
    return this.tickets.dispatchAfterCommit([ticketId]);
  }

  /** Tickets' references by id, for the views. */
  async references(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await tx.ticket.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, number: true },
    });
    return new Map(rows.map((r) => [r.id, ticketNumber(r.number)]));
  }
}
