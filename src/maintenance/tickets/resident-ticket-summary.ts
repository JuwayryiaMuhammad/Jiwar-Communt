import { Injectable } from '@nestjs/common';
import type { TicketStatus } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { residentTickets } from './resident-ticket-feed';
import { ticketNumber, UNFINISHED } from './ticket-rules';

/** A resident's tickets in two facts (ADR 0040): codes only. */
export interface TicketSummary {
  /** Tickets not finished: every status but `closed` and `cancelled`. */
  open: number;
  /** The unfinished ticket that moved last, if any. */
  latest: { id: string; number: string; status: TicketStatus } | null;
}

/**
 * What the daily brief reads of a resident's tickets (ADR 0040): how many
 * are not finished, and where the latest stands. The same tickets
 * `GET /tickets` shows them (`residentTickets`), and nothing of a ticket
 * but its number and status: no time, no text.
 */
@Injectable()
export class ResidentTicketSummary {
  constructor(private readonly community: CommunityMaintenancePort) {}

  async of(tx: TenantTxClient, accountId: string): Promise<TicketSummary> {
    const primaryOf = await this.community.primaryUnits(tx, accountId);
    const where = {
      AND: [
        residentTickets(accountId, primaryOf),
        { status: { in: [...UNFINISHED] } },
      ],
    };
    const open = await tx.ticket.count({ where });
    const latest = open
      ? await tx.ticket.findFirst({
          where,
          orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
          select: { id: true, number: true, status: true },
        })
      : null;
    return {
      open,
      latest: latest && {
        id: latest.id,
        number: ticketNumber(latest.number),
        status: latest.status,
      },
    };
  }
}
