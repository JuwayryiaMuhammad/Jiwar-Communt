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
import { PlanRequestsService } from './plan-requests.service';

/** The statuses a request ends in, as stored. */
const FINISHED = ['accepted', 'declined', 'withdrawn'];

/**
 * A resident's payment plan requests in their requests list (ADR 0058,
 * 0069): the caller's own, by their last activity, each reading as the
 * API reads it (a waiting one on an invoice done with reads lapsed). No
 * reference of their own: the search finds the invoice.
 */
@Injectable()
export class ResidentPlanItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
    private readonly requests: PlanRequestsService,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'instalment_plan_request',
      group: 'request',
      page: (tx, q) => this.page(tx, q),
    });
  }

  private async page(
    tx: TenantTxClient,
    q: PageRequest,
  ): Promise<ResidentItem[]> {
    const rows = await tx.instalmentPlanRequest.findMany({
      where: {
        AND: [
          { requestedById: this.ctx.accountId },
          ...(stateWhere(
            'status',
            q.state,
            FINISHED,
          ) as Prisma.InstalmentPlanRequestWhereInput[]),
          ...(pastCursor(
            'lastActivityAt',
            q.after,
          ) as Prisma.InstalmentPlanRequestWhereInput[]),
        ],
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: q.take,
    });
    const reads = await this.requests.reads(tx, rows);
    return rows.map((r, i) => ({
      type: 'instalment_plan_request',
      id: r.id,
      number: null,
      status: reads[i].status,
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
