import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  beforeCursor,
  UnitCorrespondence,
} from '../../core/unit-correspondence/unit-correspondence';
import { SensitiveTickets } from './sensitive-tickets';
import { ticketNumber } from './ticket-rules';

/**
 * A unit's tickets in its correspondence (ADR 0080), for dispatch: what
 * its people reported and what was opened in it. The origin and the
 * status; never a word. A sensitive ticket only for `tickets.sensitive`,
 * its appearance logged as a read (ADR 0081).
 */
@Injectable()
export class TicketCorrespondence implements OnModuleInit {
  constructor(
    private readonly registry: UnitCorrespondence,
    private readonly sensitive: SensitiveTickets,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      type: 'ticket',
      permission: 'tickets.dispatch',
      page: async (tx, unitId, q) => {
        const rows = await tx.ticket.findMany({
          where: {
            AND: [
              { unitId },
              await this.sensitive.where(),
              ...beforeCursor('createdAt', q.before),
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            origin: true,
            createdAt: true,
            sensitive: true,
          },
        });
        await this.sensitive.logReads(tx, rows, 'list');
        return rows.map((r) => ({
          type: 'ticket' as const,
          id: r.id,
          number: ticketNumber(r.number),
          kind: r.origin,
          status: r.status,
          direction:
            r.origin === 'resident'
              ? ('from_unit' as const)
              : ('to_unit' as const),
          at: r.createdAt,
        }));
      },
    });
  }
}
