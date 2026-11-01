import { Injectable, type OnModuleInit } from '@nestjs/common';
import { wantsNumber } from '../../core/resident-items/resident-items';
import { StaffSearch } from '../../core/staff-search/staff-search';
import { ticketNumber } from './ticket-rules';

/**
 * Maintenance's sources of the staff's search (ADR 0072): a ticket by its
 * number (`MT-000123`), for whoever dispatches; an asset by its code or
 * name, for whoever reads the register.
 */
@Injectable()
export class MaintenanceStaffSearchSources implements OnModuleInit {
  constructor(private readonly search: StaffSearch) {}

  onModuleInit(): void {
    this.search.register({
      type: 'ticket',
      permissions: ['tickets.dispatch', 'maintenance.manage'],
      search: async (tx, q, take) =>
        wantsNumber(q, 'MT')
          ? (
              await tx.ticket.findMany({
                where: { number: q.number! },
                take,
                select: {
                  id: true,
                  number: true,
                  category: { select: { nameEn: true } },
                },
              })
            ).map((t) => ({
              type: 'ticket' as const,
              id: t.id,
              title: ticketNumber(t.number),
              subtitle: t.category.nameEn,
            }))
          : [],
    });
    this.search.register({
      type: 'asset',
      permissions: ['assets.read'],
      search: async (tx, q, take) =>
        (
          await tx.asset.findMany({
            where: {
              OR: [
                { code: { contains: q.text, mode: 'insensitive' } },
                { nameEn: { contains: q.text, mode: 'insensitive' } },
                { nameAr: { contains: q.text } },
              ],
            },
            orderBy: [{ code: 'asc' }, { id: 'asc' }],
            take,
            select: { id: true, code: true, nameEn: true },
          })
        ).map((a) => ({
          type: 'asset' as const,
          id: a.id,
          title: a.code,
          subtitle: a.nameEn,
        })),
    });
  }
}
