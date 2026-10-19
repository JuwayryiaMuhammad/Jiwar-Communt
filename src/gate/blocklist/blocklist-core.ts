import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * The blocklist and the watchlist (ADR 0053), what its writers and its
 * readers at the gate share.
 *
 * **One lock decides.** Every write of an entry (add, edit, lift, the
 * sweep's expiry and purge) takes the compound's blocklist advisory lock
 * exclusively; every check at the gate takes it shared before reading the
 * list, and holds it to the end of its transaction. So an entry recorded
 * at the gate committed before the ban that would have refused it, or it
 * met the ban. The lock is taken after the lockdown row and before any
 * subject row (lockdown → blocklist → subject); a writer takes nothing
 * after it but its own entry.
 */
@Injectable()
export class BlocklistCore {
  constructor(private readonly ctx: RequestContext) {}

  async lockWrite(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`blocklist:${this.ctx.txTenantId}`}))`;
  }

  async lockRead(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock_shared(hashtext(${`blocklist:${this.ctx.txTenantId}`}))`;
  }

  /**
   * Live at an instant gone by (ADR 0057, an offline entry): made by then,
   * and neither lifted nor expired by then.
   */
  activeAt(at: Date): Prisma.BlocklistEntryWhereInput {
    return {
      createdAt: { lte: at },
      AND: [
        { OR: [{ liftedAt: null }, { liftedAt: { gt: at } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
      ],
    };
  }

  /** Live at `now`: not lifted, and not past its expiry. */
  active(now: Date): Prisma.BlocklistEntryWhereInput {
    return {
      liftedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
  }
}
