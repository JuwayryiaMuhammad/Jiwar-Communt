import { Injectable } from '@nestjs/common';
import type { PartnerRating } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { PartnersAccess } from '../access';
import { dbNow } from '../db-clock';
import {
  requestNotFound,
  PartnerRequestEngine,
} from '../requests/request-engine';
import { PartnerSettingsService } from '../settings/partner-settings.service';
import { PartnersService } from '../setup/partners.service';

const DAY_MS = 86_400_000;

/** Residents see a partner's average once this many have rated it. */
export const MIN_RATINGS_SHOWN = 3;

export interface RatingSummary {
  average: number;
  count: number;
}

export interface StaffRatingsQuery {
  partnerId?: string;
  cursor?: string;
  limit?: number;
}

/** A rating as the staff read it: the request's number, never who rated. */
export interface StaffRating extends PartnerRating {
  requestNumber: number;
}

const PAGE = keysetCursor('createdAt', 'desc');

/**
 * Ratings of partners (ADR 0060). The requester rates a request done,
 * within the compound's rating days of its end: 1 to 5 and an optional
 * comment, once (the key is the request), never changed. Residents see a
 * partner's average and count once three have rated it; the staff
 * (`partners.manage`) read every rating with its comment, by request
 * number, never by who rated. A rating tells nobody; the audit says that
 * it was, never how.
 */
@Injectable()
export class RatingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly engine: PartnerRequestEngine,
    private readonly settings: PartnerSettingsService,
  ) {}

  rate(
    requestId: string,
    input: { stars: number; comment?: string | null },
  ): Promise<void> {
    const comment = input.comment?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await tx.partnerRequest.findUnique({
        where: { id: requestId },
      });
      if (!found || found.requesterId !== this.ctx.accountId)
        throw requestNotFound();
      await this.partners.lock(tx, found.partnerId, 'share');
      const request = await this.engine.lock(tx, requestId);
      if (request.status !== 'done')
        throw appError.conflict(
          ErrorCode.PARTNER_REQUEST_NOT_CLOSED,
          'Only a request done is rated',
          { params: { status: request.status } },
        );
      if (
        await tx.partnerRating.findUnique({
          where: {
            tenantId_requestId: { tenantId: request.tenantId, requestId },
          },
        })
      )
        throw appError.conflict(
          ErrorCode.PARTNER_REQUEST_ALREADY_RATED,
          'The request is rated already',
        );
      const settings = await this.settings.share(tx);
      const now = await dbNow(tx);
      if (
        now.getTime() >
        request.closedAt!.getTime() + settings.ratingDays * DAY_MS
      )
        throw appError.conflict(
          ErrorCode.PARTNER_REQUEST_WINDOW_CLOSED,
          'Too late to rate it',
          { params: { days: settings.ratingDays } },
        );
      await tx.partnerRating.create({
        data: {
          tenantId: request.tenantId,
          requestId,
          partnerId: request.partnerId,
          raterAccountId: this.ctx.accountId,
          stars: input.stars,
          comment,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'partner_request.rated',
        targetId: requestId,
        metadata: {
          number: request.number,
          partnerId: request.partnerId,
          comment: comment !== null,
        },
      });
    });
  }

  /** Every partner's average and count, by partner, in one query. */
  async summaries(
    tx: TenantTxClient,
    partnerIds: readonly string[],
  ): Promise<Map<string, RatingSummary>> {
    if (!partnerIds.length) return new Map();
    const rows = await tx.partnerRating.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: [...new Set(partnerIds)] } },
      _avg: { stars: true },
      _count: { _all: true },
    });
    return new Map(
      rows.map((r) => [
        r.partnerId,
        { average: r._avg.stars ?? 0, count: r._count._all },
      ]),
    );
  }

  /** Every partner's average and count, in a transaction of its own. */
  summariesOf(
    partnerIds: readonly string[],
  ): Promise<Map<string, RatingSummary>> {
    return this.tenantTx.withTenantTx((tx) => this.summaries(tx, partnerIds));
  }

  /** The compound's ratings, newest first, for the staff. */
  staffList(q: StaffRatingsQuery): Promise<Page<StaffRating>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      // The keyset is (created_at, request_id): a rating's key is its request.
      const past = q.cursor ? PAGE.decode(q.cursor) : null;
      const rows = await tx.partnerRating.findMany({
        where: {
          AND: [
            q.partnerId ? { partnerId: q.partnerId } : {},
            past
              ? {
                  OR: [
                    { createdAt: { lt: past.at } },
                    { createdAt: past.at, requestId: { lt: past.id } },
                  ],
                }
              : {},
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { requestId: 'desc' }],
        take: limit + 1,
      });
      const page = PAGE.toPage(
        rows.map((r) => ({ ...r, id: r.requestId })),
        limit,
      );
      const numbers = new Map(
        (
          await tx.partnerRequest.findMany({
            where: { id: { in: page.items.map((r) => r.requestId) } },
            select: { id: true, number: true },
          })
        ).map((r) => [r.id, r.number]),
      );
      return {
        ...page,
        items: page.items.map((r) => ({
          ...r,
          requestNumber: numbers.get(r.requestId) ?? 0,
        })),
      };
    });
  }
}
