import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityFinancePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { DisputesService } from '../disputes/disputes.service';

/**
 * What happens to an account's money when it goes (ADR 0046), in the
 * transaction of what made it go. Nothing is deleted: invoices belong to
 * units, payments keep pointing at their payer or recorder (a tombstone
 * once erased), so there is no deletion blocker.
 *
 * - deactivated, frozen or erased: the checkouts it has open stop (an
 *   opening one fails, an open one is superseded); a page already paid
 *   still lands through the webhook, the money was taken;
 * - its residence changed: its open checkouts on units it may no longer
 *   pay for stop the same way;
 * - erased: the words and photo of the disputes it opened are cleared
 *   (ADR 0048); the disputes stay, with their codes and decisions.
 */
@Injectable()
export class FinanceLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityFinancePort,
    private readonly disputes: DisputesService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.stop(tx, account.id);
      return [];
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.stop(tx, account.id);
      await this.disputes.forget(tx, account.id);
      return [];
    });
    this.lifecycle.onFrozen(async (tx, account) => {
      await this.stop(tx, account.id);
    });
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      const live = await tx.paymentSession.findMany({
        where: { accountId: account.id, status: { in: ['opening', 'open'] } },
        select: { unitId: true },
      });
      for (const { unitId } of live) {
        const caps = await this.community.placeIn(tx, account.id, unitId);
        if (!caps?.financePay) await this.stop(tx, account.id, unitId);
      }
    });
  }

  private async stop(
    tx: TenantTxClient,
    accountId: string,
    unitId?: string,
  ): Promise<void> {
    const now = await dbNow(tx);
    const where = { accountId, ...(unitId ? { unitId } : {}) };
    await tx.paymentSession.updateMany({
      where: { ...where, status: 'open' },
      data: { status: 'superseded', resolvedAt: now },
    });
    await tx.paymentSession.updateMany({
      where: { ...where, status: 'opening' },
      data: { status: 'failed', resolvedAt: now },
    });
  }
}
