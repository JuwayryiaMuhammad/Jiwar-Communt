import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGovernancePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { BoardService } from '../board/board.service';
import { dbNow } from '../db-clock';
import { GovernanceElectionsService } from '../elections/elections.service';

/**
 * What happens to an account's governance when it goes (ADR 0051), in the
 * transaction of what made it go, which holds the account's row:
 *
 * - **It owns no unit any more** (sold, its occupancy ended), or is
 *   **deactivated** or **erased** (an erasure deactivates first): its seat
 *   on the open board ends (`no_longer_owner`, `account_closed`), and its
 *   candidacies in elections not yet voted on are withdrawn by the system.
 *   A candidate already on a list voting opened on stays on it, and is
 *   checked at the certification. An elector keeps the unit's vote in a
 *   contest already open: the electorate is that snapshot.
 * - **Erased**: its candidate statements go, once each
 *   (`statement_cleared_at`). Its votes stay: a participation names the
 *   account by id, and a secret ballot never named it at all.
 *
 * Locks: the board lock (seats), the contests' rows shared (candidacies).
 */
@Injectable()
export class GovernanceLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityGovernancePort,
    private readonly board: BoardService,
    private readonly elections: GovernanceElectionsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.gone(tx, account.id, 'account_closed');
      return [];
    });
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      if (!(await this.community.isOwner(tx, account.id)))
        await this.gone(tx, account.id, 'no_longer_owner');
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.gone(tx, account.id, 'account_closed');
      await this.forget(tx, account.id);
      return [];
    });
  }

  private async gone(
    tx: TenantTxClient,
    accountId: string,
    reason: 'no_longer_owner' | 'account_closed',
  ): Promise<void> {
    await this.board.endSeatsOf(tx, accountId, reason);
    await this.elections.withdrawAllOf(tx, accountId, reason);
  }

  /** Its statements, cleared once each. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const now = await dbNow(tx);
    const rows = await tx.$queryRaw<{ id: string; election_id: string }[]>`
      SELECT id, election_id FROM governance_candidates
       WHERE account_id = ${accountId}::uuid AND statement_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    for (const r of rows) {
      await tx.governanceCandidate.update({
        where: { id: r.id },
        data: { statement: null, statementClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'governance_candidate.statement_cleared',
        targetId: r.id,
        metadata: { electionId: r.election_id },
      });
    }
  }
}
