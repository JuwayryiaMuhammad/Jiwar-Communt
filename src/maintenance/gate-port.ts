import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { IN_HAND } from './tickets/ticket-rules';

/** A ticket in a technician's hands: what the gate's safety reads of it. */
export interface TechnicianTicket {
  id: string;
  number: number;
  status: string;
  unitId: string | null;
  commonAreaId: string | null;
  assetId: string | null;
}

/**
 * What the gate reads of maintenance (ADR 0067), in the caller's
 * transaction: a technician's own ticket, for an incident or an SOS they
 * raise from it, and tickets' numbers for the views. The gate imports
 * maintenance only through its index (ADR 0015); maintenance never imports
 * the gate.
 */
@Injectable()
export class MaintenanceGatePort {
  /** The ticket, if it is `accountId`'s and in their hands; else null. */
  async ownTicket(
    tx: TenantTxClient,
    ticketId: string,
    accountId: string,
  ): Promise<TechnicianTicket | null> {
    const ticket = await tx.ticket.findFirst({
      where: {
        id: ticketId,
        technicianId: accountId,
        status: { in: [...IN_HAND] },
      },
      select: {
        id: true,
        number: true,
        status: true,
        unitId: true,
        commonAreaId: true,
        assetId: true,
      },
    });
    return ticket;
  }

  /** Tickets' numbers and units, by id. */
  async refs(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<
    Map<string, { id: string; number: number; unitId: string | null }>
  > {
    if (!ids.length) return new Map();
    const rows = await tx.ticket.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, number: true, unitId: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }
}
