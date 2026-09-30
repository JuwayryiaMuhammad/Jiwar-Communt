import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { COMMUNITY_NOTICES } from '../notices/community-notices';
import { CommunityNotifier } from '../notices/community-notifier';
import { ReviewFlags } from '../units/review-flags';
import { lockUnits } from '../units/unit-lock';

/**
 * The community side of a frozen account (ADR 0023), run inside core's
 * transaction through AccountLifecycle:
 * - a frozen PRIMARY stays primary; each of their units goes under review
 *   (`primary_frozen`) so the manager sees it; delegations continue;
 * - a frozen household member's primaries are told;
 * - reactivation clears `primary_frozen`.
 */
@Injectable()
export class FreezeHooks implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly flags: ReviewFlags,
    private readonly notifier: CommunityNotifier,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onFrozen((tx, account) => this.frozen(tx, account));
    this.lifecycle.onReactivated((tx, account) =>
      this.reactivated(tx, account),
    );
  }

  private async frozen(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ) {
    const primaryOf = await this.primaryUnits(tx, account.id);
    await lockUnits(tx, primaryOf);
    for (const unitId of primaryOf) {
      await this.flags.flag(tx, unitId, 'primary_frozen', {
        metadata: { accountId: account.id },
      });
    }
    const memberships = await tx.householdMember.findMany({
      where: { accountId: account.id, status: 'active' },
      select: { unitId: true },
    });
    for (const m of memberships) {
      const primary = await tx.unitOccupancy.findFirst({
        where: { unitId: m.unitId, status: 'active', isPrimary: true },
        select: { accountId: true },
      });
      if (!primary) continue;
      await this.notifier.toAccounts(
        tx,
        account.tenantId,
        [primary.accountId],
        COMMUNITY_NOTICES.memberFrozen,
        await this.notifier.place(tx, account.tenantId, m.unitId),
      );
    }
  }

  private async reactivated(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ) {
    const primaryOf = await this.primaryUnits(tx, account.id);
    await lockUnits(tx, primaryOf);
    for (const unitId of primaryOf) {
      await this.flags.clear(
        tx,
        unitId,
        ['primary_frozen'],
        'account_reactivated',
      );
    }
  }

  private async primaryUnits(tx: TenantTxClient, accountId: string) {
    const rows = await tx.unitOccupancy.findMany({
      where: { accountId, status: 'active', isPrimary: true },
      select: { unitId: true },
    });
    return rows.map((r) => r.unitId);
  }
}
