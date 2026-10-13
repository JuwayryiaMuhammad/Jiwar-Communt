import { Injectable } from '@nestjs/common';
import type { NeighbourPost } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { BoardNotices } from '../posts/board-notices';

/**
 * What happens to the claims still pending on a post when it ends (ADR
 * 0042): each is declined with the system's reason and its claimant told.
 * Call under the post's lock.
 */
@Injectable()
export class ClaimDecisions {
  constructor(
    private readonly audit: AuditService,
    private readonly notices: BoardNotices,
  ) {}

  async declinePending(
    tx: TenantTxClient,
    post: Pick<NeighbourPost, 'id' | 'kind'>,
    reason: 'handed_to_another' | 'post_closed',
    now: Date,
    except: string | null = null,
  ): Promise<void> {
    const pending = await tx.neighbourItemClaim.findMany({
      where: {
        postId: post.id,
        status: 'pending',
        ...(except ? { id: { not: except } } : {}),
      },
      select: { id: true, claimantId: true },
      orderBy: { id: 'asc' },
    });
    for (const claim of pending) {
      await tx.neighbourItemClaim.update({
        where: { id: claim.id },
        data: { status: 'declined', declineReason: reason, decidedAt: now },
      });
      await this.audit.record(tx, {
        action: 'neighbour_claim.declined',
        targetId: claim.id,
        metadata: { postId: post.id, reasonCode: reason },
      });
    }
    await this.notices.to(
      tx,
      pending.map((c) => c.claimantId),
      post,
      'neighbour_claim.declined',
    );
  }
}
