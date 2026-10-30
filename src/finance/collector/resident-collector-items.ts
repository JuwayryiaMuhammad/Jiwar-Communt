import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  ResidentItems,
  pastCursor,
  stateWhere,
  type PageRequest,
  type ResidentItem,
} from '../../core/resident-items/resident-items';

const FINISHED = ['collected', 'failed', 'cancelled'];

/**
 * A resident's collector visits in their requests list (ADR 0058, 0069):
 * the ones they asked for, by their last activity. No reference of their
 * own.
 */
@Injectable()
export class ResidentCollectorItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'collector_visit',
      group: 'request',
      page: (tx, q) => this.page(tx, q),
    });
  }

  private async page(
    tx: TenantTxClient,
    q: PageRequest,
  ): Promise<ResidentItem[]> {
    const rows = await tx.collectorVisit.findMany({
      where: {
        AND: [
          { requestedById: this.ctx.accountId },
          ...(stateWhere(
            'status',
            q.state,
            FINISHED,
          ) as Prisma.CollectorVisitWhereInput[]),
          ...(pastCursor(
            'lastActivityAt',
            q.after,
          ) as Prisma.CollectorVisitWhereInput[]),
        ],
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: q.take,
      select: { id: true, status: true, unitId: true, lastActivityAt: true },
    });
    return rows.map((r) => ({
      type: 'collector_visit',
      id: r.id,
      number: null,
      status: r.status,
      lastActivityAt: r.lastActivityAt,
      unitId: r.unitId,
      kind: null,
      categoryKey: null,
      topicKey: null,
      requestType: null,
      appeal: null,
    }));
  }
}
