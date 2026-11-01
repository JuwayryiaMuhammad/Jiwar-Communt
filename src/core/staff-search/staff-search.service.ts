import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PermissionsService } from '../access/permissions.service';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { TenantTx } from '../database/tenant-tx.service';
import { RateLimitService } from '../redis/rate-limit.service';
import { parseItemQuery } from '../resident-items/resident-items';
import { StaffSearch, type StaffSearchHit } from './staff-search';

/** At most this many of a kind (ADR 0072). */
export const STAFF_SEARCH_PER_TYPE = 8;
/** Searches per account per minute. */
export const STAFF_SEARCH_RATE = { limit: 60, windowSeconds: 60 } as const;

/**
 * The top bar's search for the staff and the manager (ADR 0072): one field,
 * results by kind, each kind from the sources the caller may read.
 * References (`MT-000123`, `123`) and words (a code, a name) alike;
 * rate-limited per account.
 */
@Injectable()
export class StaffSearchService implements OnApplicationBootstrap {
  constructor(
    private readonly search: StaffSearch,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly rateLimit: RateLimitService,
    private readonly permissions: PermissionsService,
  ) {}

  onApplicationBootstrap(): void {
    const missing = this.search.missing();
    if (missing.length)
      throw new Error(`Staff search sources missing: ${missing.join(', ')}`);
  }

  async find(raw: string): Promise<StaffSearchHit[]> {
    const type = this.ctx.accountType;
    if (type !== 'staff' && type !== 'manager')
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'The staff’s search: residents have their own (GET /me/search)',
      );
    await this.rateLimit.consume(
      `staff-search:${this.ctx.tenantId}:${this.ctx.accountId}`,
      STAFF_SEARCH_RATE.limit,
      STAFF_SEARCH_RATE.windowSeconds,
    );
    const q = parseItemQuery(raw);
    // Outside the transaction: the permissions read on their own.
    const held = await this.permissions.current();
    const sources = this.search
      .all()
      .filter((s) => s.permissions.some((p) => held.has(p)));
    return this.tenantTx.withTenantTx(async (tx) => {
      const out: StaffSearchHit[] = [];
      for (const s of sources)
        out.push(...(await s.search(tx, q, STAFF_SEARCH_PER_TYPE)));
      return out;
    });
  }
}
