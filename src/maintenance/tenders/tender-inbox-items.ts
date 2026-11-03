import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { tenderReference } from './tender-rules';

/**
 * A tender waiting to be opened, in the staff inbox (ADR 0073, 0088): past
 * its deadline and not yet begun, or begun by one holder of `tenders.open`
 * and waiting for a second. Seen by `tenders.open`, waiting since its
 * deadline; opened on its own route, never in bulk (two people, one at a
 * time).
 */
const WAITING = (now: Date): Prisma.TenderWhereInput => ({
  OR: [{ status: 'open', bidsDueAt: { lte: now } }, { status: 'opening' }],
});

@Injectable()
export class TenderInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'tender_opening',
      permission: 'tenders.open',
      dueHours: 48,
      page: async (tx, q) => {
        const rows = await tx.tender.findMany({
          where: {
            AND: [
              WAITING(new Date()),
              ...waitingSince('bidsDueAt', q.requestedBefore),
              ...afterCursor('bidsDueAt', q.after),
            ],
          },
          orderBy: [{ bidsDueAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            bidsDueAt: true,
            estimatedValue: true,
          },
        });
        return rows.map((r) => ({
          type: 'tender_opening' as const,
          id: r.id,
          number: tenderReference(r.number),
          kind: null,
          status: r.status,
          unitId: null,
          requestedAt: r.bidsDueAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.tender.count({
          where: {
            AND: [WAITING(new Date()), ...waitingSince('bidsDueAt', before)],
          },
        }),
    });
  }
}
