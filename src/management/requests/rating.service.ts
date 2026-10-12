import { Injectable } from '@nestjs/common';
import type { ManagementRequestRating } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { RequestAccess } from './request-access';
import { assertCan } from './request-rules';

export const RATING = { min: 1, max: 5 } as const;
export const RATING_COMMENT_LENGTH = { min: 1, max: 1000 } as const;

export interface NewRating {
  rating: number;
  comment?: string;
}

/**
 * How the author rates a closed request (ADR 0039): 1 to 5 and an optional
 * comment, once per request (the table's primary key), never changed (its
 * trigger). The author reads their own; the staff who handle requests do
 * not see ratings — only `requests.manage` does, on its own routes.
 */
@Injectable()
export class RatingService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: RequestAccess,
    private readonly audit: AuditService,
  ) {}

  rate(requestId: string, input: NewRating): Promise<ManagementRequestRating> {
    const comment = input.comment?.trim() || null;
    if (comment && comment.length > RATING_COMMENT_LENGTH.max)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid rating', {
        fields: [
          {
            field: 'comment',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { ...RATING_COMMENT_LENGTH },
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.access.load(tx, requestId, 'resident', {
        lock: true,
      });
      assertCan(request, 'rate');
      if (await this.of(tx, requestId))
        throw appError.conflict(
          ErrorCode.MANAGEMENT_REQUEST_ALREADY_RATED,
          'This request was already rated',
        );
      const rating = await tx.managementRequestRating.create({
        data: {
          tenantId: request.tenantId,
          requestId,
          authorId: this.ctx.accountId,
          rating: input.rating,
          comment,
          createdAt: await dbNow(tx),
        },
      });
      // That it was rated, never how: the trail is not where ratings are read.
      await this.audit.record(tx, {
        action: 'management_request.rated',
        targetId: requestId,
        metadata: { requestNumber: request.number, cycle: request.cycle },
      });
      return rating;
    });
  }

  /** A request's rating, in the caller's transaction (the caller checked access). */
  of(
    tx: TenantTxClient,
    requestId: string,
  ): Promise<ManagementRequestRating | null> {
    return tx.managementRequestRating.findFirst({ where: { requestId } });
  }

  /** One request's rating, for `requests.manage`. */
  forManager(requestId: string): Promise<ManagementRequestRating | null> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, requestId, 'staff');
      return this.of(tx, requestId);
    });
  }

  /** The compound's ratings, newest first, for `requests.manage`. */
  list(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<ManagementRequestRating>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const after = decode(q.cursor);
      const rows = await tx.managementRequestRating.findMany({
        where: after
          ? {
              OR: [
                { createdAt: { lt: after.at } },
                { createdAt: after.at, requestId: { lt: after.requestId } },
              ],
            }
          : {},
        orderBy: [{ createdAt: 'desc' }, { requestId: 'desc' }],
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify([last.createdAt.toISOString(), last.requestId]),
              ).toString('base64url')
            : null,
      };
    });
  }
}

/** The lists' cursor, `[iso, id]` in base64url; here the id is the request's. */
function decode(
  cursor: string | undefined,
): { at: Date; requestId: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [unknown, unknown];
    const at = typeof iso === 'string' ? new Date(iso) : new Date(NaN);
    if (
      !Number.isNaN(at.getTime()) &&
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id)
    )
      return { at, requestId: id };
  } catch {
    // fall through
  }
  throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid cursor', {
    fields: [{ field: 'cursor', code: FieldErrorCode.INVALID_FORMAT }],
  });
}
