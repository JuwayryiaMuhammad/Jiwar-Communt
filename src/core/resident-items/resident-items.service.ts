import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PermissionsService } from '../access/permissions.service';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import { TenantTx } from '../database/tenant-tx.service';
import { RateLimitService } from '../redis/rate-limit.service';
import {
  byActivity,
  parseItemQuery,
  ResidentItems,
  type ResidentItem,
  type ItemCaller,
  type ItemState,
  type ResidentItemGroup,
} from './resident-items';

const PAGE = keysetCursor('lastActivityAt');

/** At most this many per source, and this many in all (ADR 0058). */
export const SEARCH_PER_TYPE = 10;
export const SEARCH_MAX = 50;
/** Searches per account per minute: references cannot be enumerated. */
export const SEARCH_RATE = { limit: 30, windowSeconds: 60 } as const;

/**
 * A resident's lists across the domains (ADR 0058): everything they asked
 * for (`GET /me/requests`, ADR 0039's list widened), every appeal
 * (`GET /me/appeals`) and the search over their own items. Residents and
 * their family only.
 *
 * Every source is read past the same cursor with limit + 1 in one
 * transaction, and merged on (lastActivityAt, id), newest first. Activity
 * moves an item up, so an item that changes between two pages may be seen
 * twice or not at all: a list to look at, never to count with. With
 * `state=closed` the list is the archive: what is finished (each source's
 * own finished statuses).
 */
@Injectable()
export class ResidentItemsService implements OnApplicationBootstrap {
  constructor(
    private readonly items: ResidentItems,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly rateLimit: RateLimitService,
    private readonly permissions: PermissionsService,
  ) {}

  onApplicationBootstrap(): void {
    const missing = this.items.missing();
    if (missing.length)
      throw new Error(`Resident item sources missing: ${missing.join(', ')}`);
  }

  async list(
    group: ResidentItemGroup,
    q: { cursor?: string; limit?: number; state?: ItemState },
  ): Promise<Page<ResidentItem>> {
    this.residentsOnly();
    const limit = clampLimit(q.limit);
    const after = q.cursor ? PAGE.decode(q.cursor) : null;
    const caller = await this.caller();
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const out: ResidentItem[] = [];
      for (const source of this.items.of(group))
        out.push(
          ...(await source.page!(tx, {
            after,
            take: limit + 1,
            state: q.state ?? null,
            caller,
          })),
        );
      return out;
    });
    rows.sort(byActivity);
    return PAGE.toPage(rows, limit);
  }

  /**
   * The caller's own items matching `raw` (ADR 0058): a reference, or the
   * names the compound wrote. Never anyone's free text. Rate-limited per
   * account; the device keeps the history.
   */
  async search(raw: string): Promise<ResidentItem[]> {
    this.residentsOnly();
    await this.rateLimit.consume(
      `resident-search:${this.ctx.tenantId}:${this.ctx.accountId}`,
      SEARCH_RATE.limit,
      SEARCH_RATE.windowSeconds,
    );
    const q = parseItemQuery(raw);
    const caller = await this.caller();
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const out: ResidentItem[] = [];
      for (const source of this.items.searchable())
        out.push(...(await source.search!(tx, q, SEARCH_PER_TYPE, caller)));
      return out;
    });
    return rows.sort(byActivity).slice(0, SEARCH_MAX);
  }

  private async caller(): Promise<ItemCaller> {
    const held = await this.permissions.current();
    return { holds: (p) => held.has(p) };
  }

  private residentsOnly(): void {
    const type = this.ctx.accountType;
    if (type !== 'resident' && type !== 'family')
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Only residents and their family have these lists',
      );
  }
}
