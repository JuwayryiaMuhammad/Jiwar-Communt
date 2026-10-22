import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PartnerRequest, Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  ResidentItems,
  pastCursor,
  stateWhere,
  wantsNumber,
  type ItemCaller,
  type ItemQuery,
  type PageRequest,
  type ResidentItem,
} from '../../core/resident-items/resident-items';
import { LIVE, PARTNER_REQUEST_STATUSES, requestNumber } from './request-rules';

/** The statuses a request ends in: all but the live ones. */
const FINISHED = PARTNER_REQUEST_STATUSES.filter((s) => !LIVE.includes(s));

type Row = Pick<
  PartnerRequest,
  'id' | 'number' | 'status' | 'unitId' | 'category' | 'lastActivityAt'
>;

const SELECT = {
  id: true,
  number: true,
  status: true,
  unitId: true,
  category: true,
  lastActivityAt: true,
} as const;

/**
 * Requests to partners in the resident's requests list and search (ADR
 * 0058, 0060), as `GET /partner-requests` lists them: the caller's own, for
 * `partners.request` holders. By their last activity; the kind is the
 * category's code. The search finds one by its reference (`SR-000123`) or
 * by the partner's name, which the compound wrote.
 */
@Injectable()
export class ResidentPartnerItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'partner_request',
      group: 'request',
      page: (tx, q) => this.page(tx, q),
      search: (tx, q, take, caller) => this.search(tx, q, take, caller),
    });
  }

  private async page(
    tx: TenantTxClient,
    q: PageRequest,
  ): Promise<ResidentItem[]> {
    if (!q.caller.holds('partners.request')) return [];
    const rows = await tx.partnerRequest.findMany({
      where: {
        AND: [
          { requesterId: this.ctx.accountId },
          ...(stateWhere(
            'status',
            q.state,
            FINISHED,
          ) as Prisma.PartnerRequestWhereInput[]),
          ...(pastCursor(
            'lastActivityAt',
            q.after,
          ) as Prisma.PartnerRequestWhereInput[]),
        ],
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: q.take,
      select: SELECT,
    });
    return rows.map(item);
  }

  private async search(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
    caller: ItemCaller,
  ): Promise<ResidentItem[]> {
    if (!caller.holds('partners.request')) return [];
    const named = await tx.partner.findMany({
      where: {
        OR: [
          { nameEn: { contains: q.text, mode: 'insensitive' } },
          { nameAr: { contains: q.text, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });
    const byName: Prisma.PartnerRequestWhereInput = {
      partnerId: { in: named.map((p) => p.id) },
    };
    const rows = await tx.partnerRequest.findMany({
      where: {
        requesterId: this.ctx.accountId,
        OR: wantsNumber(q, 'SR') ? [{ number: q.number! }, byName] : [byName],
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take,
      select: SELECT,
    });
    return rows.map(item);
  }
}

function item(r: Row): ResidentItem {
  return {
    type: 'partner_request',
    id: r.id,
    number: requestNumber(r.number),
    status: r.status,
    lastActivityAt: r.lastActivityAt,
    unitId: r.unitId,
    kind: r.category,
    categoryKey: null,
    topicKey: null,
    requestType: null,
    appeal: null,
  };
}
