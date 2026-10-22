import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ManagementRequestStatus, Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  pastCursor,
  ResidentItems,
  type ItemCaller,
  wantsNumber,
  type ItemQuery,
  type PageRequest,
  type ResidentItem,
} from '../../core/resident-items/resident-items';
import { requestNumber } from '../requests/request-rules';

const FINISHED: ManagementRequestStatus[] = ['closed'];

/**
 * Management requests in the resident's lists and search (ADR 0039, 0058):
 * a request is its author's alone, whatever unit it names. A certificate or
 * a letter is a request on the `documents` topic, and listed as one. For
 * `requests.create` holders only.
 */
@Injectable()
export class ResidentRequestItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'management',
      group: 'request',
      page: (tx, q) => this.page(tx, q),
      search: (tx, q, take, caller) => this.search(tx, q, take, caller),
    });
  }

  private async page(
    tx: TenantTxClient,
    q: PageRequest,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('requests.create')) return [];
    return this.read(
      tx,
      [
        ...(q.state
          ? [
              {
                status:
                  q.state === 'closed' ? { in: FINISHED } : { notIn: FINISHED },
              },
            ]
          : []),
        ...(pastCursor(
          'lastActivityAt',
          q.after,
        ) as Prisma.ManagementRequestWhereInput[]),
      ],
      q.take,
    );
  }

  /** By number (`MR-…`), or a topic's name. */
  private async search(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
    caller: ItemCaller,
  ): Promise<ResidentItem[]> {
    if (!caller.holds('requests.create')) return [];
    const or: Prisma.ManagementRequestWhereInput[] = [
      {
        topic: {
          OR: [
            { nameEn: { contains: q.text, mode: 'insensitive' } },
            { nameAr: { contains: q.text, mode: 'insensitive' } },
          ],
        },
      },
    ];
    if (wantsNumber(q, 'MR')) or.push({ number: q.number! });
    return this.read(tx, [{ OR: or }], take);
  }

  private async read(
    tx: TenantTxClient,
    and: Prisma.ManagementRequestWhereInput[],
    take: number,
  ): Promise<ResidentItem[]> {
    const rows = await tx.managementRequest.findMany({
      where: { AND: [{ authorId: this.ctx.accountId }, ...and] },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        number: true,
        status: true,
        type: true,
        unitId: true,
        lastActivityAt: true,
        topic: { select: { key: true } },
      },
    });
    return rows.map((r) => ({
      type: 'management',
      id: r.id,
      number: requestNumber(r.number),
      status: r.status,
      lastActivityAt: r.lastActivityAt,
      unitId: r.unitId,
      kind: null,
      categoryKey: null,
      topicKey: r.topic.key,
      requestType: r.type,
      appeal: null,
    }));
  }
}
