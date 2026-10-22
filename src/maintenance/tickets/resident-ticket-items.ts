import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma, TicketStatus } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  ResidentItems,
  type ItemCaller,
  wantsNumber,
  type ItemQuery,
  type PageRequest,
  type ResidentItem,
} from '../../core/resident-items/resident-items';
import { ResidentTicketFeed, type FeedTicket } from './resident-ticket-feed';

/** A ticket is finished when it is closed or cancelled. */
const FINISHED: TicketStatus[] = ['closed', 'cancelled'];

/**
 * Tickets in the resident's lists and search (ADR 0039, 0058), through the
 * feed: exactly what `GET /tickets` shows, dated as the feed dates them
 * for someone who left the unit. For `tickets.create` holders only.
 */
@Injectable()
export class ResidentTicketItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly feed: ResidentTicketFeed,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'maintenance',
      group: 'request',
      page: (tx, q) => this.page(tx, q),
      search: (tx, q, take, caller) => this.search(tx, q, take, caller),
    });
  }

  private async page(
    tx: TenantTxClient,
    q: PageRequest,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('tickets.create')) return [];
    const only: Prisma.TicketWhereInput = q.state
      ? {
          status: q.state === 'closed' ? { in: FINISHED } : { notIn: FINISHED },
        }
      : {};
    return (await this.feed.page(tx, q.after, q.take, only)).map(item);
  }

  /** By number (`MT-…`), or a category's name. */
  private async search(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
    caller: ItemCaller,
  ): Promise<ResidentItem[]> {
    if (!caller.holds('tickets.create')) return [];
    const or: Prisma.TicketWhereInput[] = [
      {
        category: {
          OR: [
            { nameEn: { contains: q.text, mode: 'insensitive' } },
            { nameAr: { contains: q.text, mode: 'insensitive' } },
          ],
        },
      },
    ];
    if (wantsNumber(q, 'MT')) or.push({ number: q.number! });
    return (await this.feed.page(tx, null, take, { OR: or })).map(item);
  }
}

const item = (t: FeedTicket): ResidentItem => ({
  type: 'maintenance',
  id: t.id,
  number: t.number,
  status: t.status,
  lastActivityAt: t.lastActivityAt,
  unitId: t.unitId,
  kind: null,
  categoryKey: t.categoryKey,
  topicKey: null,
  requestType: null,
  appeal: null,
});
