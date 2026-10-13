import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Whose posts a resident does not see on the boards (ADR 0042): anyone
 * they blocked, and anyone who blocked them. Each silently stops seeing
 * the other's posts, so neither can tell from a board who is behind a
 * block. Kept apart so the board never has to know why an author is
 * hidden.
 */
@Injectable()
export class PostVisibility {
  /** The accounts whose posts `accountId` must not see. */
  async hiddenAuthors(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<string[]> {
    const blocks = await tx.neighbourBlock.findMany({
      where: { OR: [{ blockerId: accountId }, { blockedId: accountId }] },
      select: { blockerId: true, blockedId: true },
    });
    return [
      ...new Set(
        blocks.map((b) =>
          b.blockerId === accountId ? b.blockedId : b.blockerId,
        ),
      ),
    ];
  }
}
