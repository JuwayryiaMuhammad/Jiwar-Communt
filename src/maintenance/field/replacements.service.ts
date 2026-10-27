import { Injectable } from '@nestjs/common';
import type { AssetReplacementRecommendation } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { AssetsService } from '../assets/assets.service';
import { dbNow } from '../db-clock';
import { TicketAccess } from '../tickets/ticket-access';

const PAGE = keysetCursor('recommendedAt', 'desc');

/**
 * The technicians' recommendations to replace (ADR 0064), decided once by
 * who keeps the register: accepted (the capital plan takes it up, a later
 * phase), or declined with a reason. The asset's history keeps both.
 */
@Injectable()
export class ReplacementsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly assets: AssetsService,
    private readonly audit: AuditService,
  ) {}

  list(q: {
    status?: 'pending' | 'accepted' | 'declined';
    assetId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<AssetReplacementRecommendation>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.assetReplacementRecommendation.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.assetId ? { assetId: q.assetId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  decide(
    id: string,
    input: { accept: boolean; reasonCode?: string },
  ): Promise<AssetReplacementRecommendation> {
    const reason = input.accept
      ? null
      : requireReasonCodeOnly(
          input.reasonCode,
          REASON_CODES.replacementDecline,
        );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.assetReplacementRecommendation.findUnique({
        where: { id },
      });
      if (!seen)
        throw appError.notFound(
          ErrorCode.REPLACEMENT_RECOMMENDATION_NOT_FOUND,
          'Recommendation not found',
        );
      await tx.$queryRaw`SELECT id FROM assets WHERE id = ${seen.assetId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM asset_replacement_recommendations WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.assetReplacementRecommendation.findUniqueOrThrow({
        where: { id },
      });
      if (row.status !== 'pending')
        throw appError.conflict(
          ErrorCode.REPLACEMENT_RECOMMENDATION_DECIDED,
          'This recommendation is decided',
          { params: { status: row.status } },
        );
      const decided = await tx.assetReplacementRecommendation.update({
        where: { id },
        data: {
          status: input.accept ? 'accepted' : 'declined',
          decidedById: this.ctx.accountId,
          decidedAt: await dbNow(tx),
          decisionReason: reason,
        },
      });
      await this.assets.event(tx, row.assetId, 'replacement_decided', {
        to: decided.status,
        reason,
      });
      await this.audit.record(tx, {
        action: input.accept
          ? 'asset_replacement.accepted'
          : 'asset_replacement.declined',
        targetId: id,
        metadata: { assetId: row.assetId, reasonCode: reason },
      });
      return decided;
    });
  }
}
