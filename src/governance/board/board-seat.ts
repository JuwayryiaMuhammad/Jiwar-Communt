import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DerivedGrants } from '../../core/access/derived-grants';
import { TenantTx } from '../../core/database/tenant-tx.service';

/**
 * A sitting board member's `governance.board` (ADR 0051), derived from the
 * seat on every request that needs it and never cached: a term that ends,
 * lapses or is succeeded, and a seat that is ended, stop it on the next
 * request. An action taken with it checks the seat again under its lock
 * (GovernanceAccess.requireAuthor).
 */
@Injectable()
export class BoardSeat implements OnModuleInit {
  constructor(
    private readonly grants: DerivedGrants,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.grants.register('governance.board', (accountId) =>
      this.sits(accountId),
    );
  }

  /** Whether the account holds a seat in the board sitting now. */
  sits(accountId: string): Promise<boolean> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM board_members m
          JOIN board_terms t ON t.tenant_id = m.tenant_id AND t.id = m.term_id
         WHERE m.account_id = ${accountId}::uuid AND m.ended_at IS NULL
           AND t.ended_at IS NULL
           AND t.starts_at <= clock_timestamp() AND t.ends_at > clock_timestamp()
         LIMIT 1`;
      return rows.length > 0;
    });
  }
}
