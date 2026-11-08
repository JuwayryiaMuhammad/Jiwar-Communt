import { Injectable, Logger } from '@nestjs/common';
import { SecurityEventsService } from '../audit/security-events.service';
import { runAfterCommit } from '../accounts/account-lifecycle';
import { AccountWriter, type StatusChange } from '../accounts/account-writer';
import { RequestContext } from '../common/cls/request-context';
import { GlobalDbService } from '../database/global-db.service';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** The kinds an account check looks at: the compound's side (ADR 0090). */
export const CHECKED_TYPES = ['staff', 'manager', 'contractor'] as const;

export const IDLE_DAYS = { min: 14, max: 365, default: 60 } as const;
export const REVIEW_EVERY_DAYS = { min: 30, max: 365, default: 90 } as const;
/** An account nobody signed into this long after its creation is dangling. */
export const NEVER_SIGNED_IN_DAYS = 14;
/** A kept finding is muted this long. */
export const KEEP_MUTE_DAYS = 90;
export const DAY_MS = 86_400_000;

export interface AccountCheckSettingsRead {
  idleDays: number;
  reviewEveryDays: number;
}

/**
 * What both account checks share (ADR 0090): the compound's settings, the
 * accounts' last sign-in, and a deactivation in the deciding transaction
 * whose after-commit work runs once it committed, as `PATCH
 * /accounts/{id}/status` does.
 */
@Injectable()
export class AccountChecks {
  private readonly logger = new Logger(AccountChecks.name);

  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly writer: AccountWriter,
    private readonly securityEvents: SecurityEventsService,
    private readonly ctx: RequestContext,
  ) {}

  async settings(tx: TenantTxClient): Promise<AccountCheckSettingsRead> {
    // The compound's own row (RLS): one at most.
    const row = await tx.accountCheckSettings.findFirst();
    return {
      idleDays: row?.idleDays ?? IDLE_DAYS.default,
      reviewEveryDays: row?.reviewEveryDays ?? REVIEW_EVERY_DAYS.default,
    };
  }

  /**
   * The accounts' last sign-in or use of a session, or null for one never
   * signed into. Sessions are kept after they end (ADR 0004).
   */
  async lastActive(
    tx: TenantTxClient,
    tenantId: string,
    accountIds: readonly string[],
  ): Promise<Map<string, Date>> {
    if (!accountIds.length) return new Map();
    const rows = await this.globalDb.in(tx).session.groupBy({
      by: ['accountId'],
      where: { tenantId, accountId: { in: [...accountIds] } },
      _max: { createdAt: true, lastUsedAt: true },
    });
    return new Map(
      rows.map((r) => {
        const created = r._max.createdAt!;
        const used = r._max.lastUsedAt;
        return [r.accountId, used && used > created ? used : created];
      }),
    );
  }

  /**
   * Deactivates the account in the caller's transaction (its row locked
   * FOR UPDATE, the domains' hooks run); returns what to run after commit.
   */
  async deactivate(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<StatusChange | null> {
    return this.writer.setStatus(tx, accountId, 'inactive');
  }

  /** A deactivation's after-commit work and its security event. */
  async afterDeactivation(change: StatusChange | null): Promise<void> {
    if (!change) return;
    await runAfterCommit(change.afterCommit, this.logger);
    if (change.sessionsRevoked)
      await this.securityEvents.record('session.revoked', {
        tenantId: change.account.tenantId,
        accountId: change.account.id,
        metadata: {
          reason: 'account_deactivated',
          count: change.sessionsRevoked,
        },
      });
  }

  /** The account's row, locked for the rest of the transaction. */
  async lockAccount(
    tx: TenantTxClient,
    accountId: string,
    mode: 'share' | 'update',
  ): Promise<{ type: string; status: string } | null> {
    const [row] =
      mode === 'update'
        ? await tx.$queryRaw<{ type: string; status: string }[]>`
            SELECT type::text AS type, status::text AS status FROM accounts
             WHERE id = ${accountId}::uuid FOR UPDATE`
        : await tx.$queryRaw<{ type: string; status: string }[]>`
            SELECT type::text AS type, status::text AS status FROM accounts
             WHERE id = ${accountId}::uuid FOR SHARE`;
    return row ?? null;
  }

  get me(): string {
    return this.ctx.accountId;
  }
}
