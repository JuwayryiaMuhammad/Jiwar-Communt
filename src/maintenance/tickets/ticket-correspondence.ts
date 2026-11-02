import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  beforeCursor,
  UnitCorrespondence,
} from '../../core/unit-correspondence/unit-correspondence';
import { ticketNumber } from './ticket-rules';

/**
 * A unit's tickets in its correspondence (ADR 0080), for dispatch: what
 * its people reported and what was opened in it. The origin and the
 * status; never a word.
 */
@Injectable()
export class TicketCorrespondence implements OnModuleInit {
  constructor(private readonly registry: UnitCorrespondence) {}

  onModuleInit(): void {
    this.registry.register({
      type: 'ticket',
      permission: 'tickets.dispatch',
      page: async (tx, unitId, q) => {
        const rows = await tx.ticket.findMany({
          where: { AND: [{ unitId }, ...beforeCursor('createdAt', q.before)] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            origin: true,
            createdAt: true,
          },
        });
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
