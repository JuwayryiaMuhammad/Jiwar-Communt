import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { NeighbourComplaintStatus, Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  pastCursor,
  ResidentItems,
  type ItemCaller,
  stateWhere,
  wantsNumber,
  type ItemQuery,
  type ResidentItem,
} from '../../core/resident-items/resident-items';
import { complaintNumber } from './complaint-rules';

/**
 * Neighbour complaints in the resident's lists and search (ADR 0042,
 * 0058): a complaint is its author's alone, as `GET /neighbour-complaints`
 * shows it, with the author's own unit and never the unit complained
 * about. For `neighbours.complain` holders only.
 */
@Injectable()
export class ResidentComplaintItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'neighbour_complaint',
      group: 'request',
      page: (tx, q) =>
        this.read(
          tx,
          q.caller,
          [
            ...stateWhere('status', q.state, FINISHED),
            ...pastCursor('lastActivityAt', q.after),
          ] as Prisma.NeighbourComplaintWhereInput[],
          q.take,
        ),
      search: (tx, q, take, caller) => this.search(tx, q, take, caller),
    });
  }

  /** By number (`NC-…`), or a category's name. */
  private search(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
    caller: ItemCaller,
  ): Promise<ResidentItem[]> {
    const or: Prisma.NeighbourComplaintWhereInput[] = [
      {
        category: {
          OR: [
            { nameEn: { contains: q.text, mode: 'insensitive' } },
            { nameAr: { contains: q.text, mode: 'insensitive' } },
          ],
        },
      },
    ];
    if (wantsNumber(q, 'NC')) or.push({ number: q.number! });
    return this.read(tx, caller, [{ OR: or }], take);
  }

  private async read(
    tx: TenantTxClient,
    caller: ItemCaller,
    and: Prisma.NeighbourComplaintWhereInput[],
    take: number,
  ): Promise<ResidentItem[]> {
    if (!caller.holds('neighbours.complain')) return [];
    const rows = await tx.neighbourComplaint.findMany({
      where: { AND: [{ authorId: this.ctx.accountId }, ...and] },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        number: true,
        status: true,
        authorUnitId: true,
        lastActivityAt: true,
        category: { select: { key: true } },
      },
    });
    return rows.map((r) => ({
      type: 'neighbour_complaint',
      id: r.id,
      number: complaintNumber(r.number),
      status: r.status,
      lastActivityAt: r.lastActivityAt,
      unitId: r.authorUnitId,
      kind: r.category.key,
      categoryKey: null,
      topicKey: null,
      requestType: null,
      appeal: null,
    }));
  }
}

/** Finished: every status that is not open. */
const FINISHED: NeighbourComplaintStatus[] = ['resolved', 'dismissed'];
