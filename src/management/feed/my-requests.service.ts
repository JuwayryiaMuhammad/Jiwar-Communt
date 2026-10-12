import { Injectable } from '@nestjs/common';
import type { ManagementRequestType } from '@prisma/client';
import { PermissionsService } from '../../core/access/permissions.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { ResidentTicketFeed } from '../../maintenance';
import { requestNumber } from '../requests/request-rules';

/** One row of "all my requests": a ticket or a management request. */
export interface MyRequest {
  type: 'maintenance' | 'management';
  id: string;
  /** `MT-000123` or `MR-000123`. */
  number: string;
  /** The item's own status: a ticket's or a request's. */
  status: string;
  lastActivityAt: Date;
  /** A ticket's category key. */
  categoryKey: string | null;
  /** A management request's topic key and kind. */
  topicKey: string | null;
  requestType: ManagementRequestType | null;
  unitId: string | null;
}

/** The lists' cursor format, on the one column both sources order by. */
const PAGE = keysetCursor('lastActivityAt');

/**
 * "All my requests" (ADR 0039): the caller's management requests and the
 * maintenance tickets they can see, as one list ordered by last activity.
 *
 * Each source decides what the caller sees of it, by its own rule: a
 * management request is its author's alone; tickets are the ones
 * `GET /tickets` lists, read through maintenance's own feed, which also
 * keeps what was written after someone left a unit from moving their list.
 * A caller whose role lacks one of the two permissions gets the other
 * source alone.
 *
 * Both are read past the same cursor with limit + 1 and merged on
 * (lastActivityAt, id), newest first. Activity moves an item up, so an item
 * that changes between two pages may be seen twice or not at all: a list
 * to look at, never to count with.
 */
@Injectable()
export class MyRequestsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly permissions: PermissionsService,
    private readonly tickets: ResidentTicketFeed,
  ) {}

  async list(q: { cursor?: string; limit?: number }): Promise<Page<MyRequest>> {
    const limit = clampLimit(q.limit);
    const after = q.cursor ? PAGE.decode(q.cursor) : null;
    const [mayAsk, mayReport] = [
      await this.permissions.has('requests.create'),
      await this.permissions.has('tickets.create'),
    ];
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const requests = mayAsk
        ? await tx.managementRequest.findMany({
            where: {
              AND: [{ authorId: this.ctx.accountId }, ...PAGE.after(q.cursor)],
            },
            orderBy: PAGE.orderBy,
            take: limit + 1,
            select: {
              id: true,
              number: true,
              status: true,
              type: true,
              unitId: true,
              lastActivityAt: true,
              topic: { select: { key: true } },
            },
          })
        : [];
      const tickets = mayReport
        ? await this.tickets.page(tx, after, limit + 1)
        : [];
      return [
        ...requests.map((r): MyRequest => ({
          type: 'management',
          id: r.id,
          number: requestNumber(r.number),
          status: r.status,
          lastActivityAt: r.lastActivityAt,
          categoryKey: null,
          topicKey: r.topic.key,
          requestType: r.type,
          unitId: r.unitId,
        })),
        ...tickets.map((t): MyRequest => ({
          type: 'maintenance',
          id: t.id,
          number: t.number,
          status: t.status,
          lastActivityAt: t.lastActivityAt,
          categoryKey: t.categoryKey,
          topicKey: null,
          requestType: null,
          unitId: t.unitId,
        })),
      ];
    });
    // The database's order for both: time, then id, both descending.
    rows.sort(
      (a, b) =>
        b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
        (a.id < b.id ? 1 : -1),
    );
    return PAGE.toPage(rows, limit);
  }
}
