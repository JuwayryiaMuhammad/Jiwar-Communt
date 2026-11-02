import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  beforeCursor,
  UnitCorrespondence,
} from '../unit-correspondence/unit-correspondence';
import { noticeNumber } from './formal-notices.service';

/**
 * A unit's formal notices in its correspondence (ADR 0080), for whoever
 * invoices: the notice's type, and that it went out.
 */
@Injectable()
export class NoticeCorrespondence implements OnModuleInit {
  constructor(private readonly registry: UnitCorrespondence) {}

  onModuleInit(): void {
    this.registry.register({
      type: 'formal_notice',
      permission: 'finance.invoice',
      page: async (tx, unitId, q) => {
        const rows = await tx.formalNotice.findMany({
          where: { AND: [{ unitId }, ...beforeCursor('issuedAt', q.before)] },
          orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
          take: q.take,
          select: { id: true, number: true, type: true, issuedAt: true },
        });
        return rows.map((r) => ({
          type: 'formal_notice' as const,
          id: r.id,
          number: noticeNumber(r.number),
          kind: r.type,
          status: 'issued',
          direction: 'to_unit' as const,
          at: r.issuedAt,
        }));
      },
    });
  }
}
