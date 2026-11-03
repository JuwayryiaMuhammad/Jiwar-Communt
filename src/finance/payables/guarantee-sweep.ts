import { Injectable, type OnModuleInit } from '@nestjs/common';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { addDays } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow, fromDate, localToday } from '../db-clock';
import { GUARANTEE_NOTICE_DAYS } from './payable-rules';

export const GUARANTEE_SWEEP = 'finance.vendor_guarantees';
/** Guarantees expire on a day: an hourly look is soon enough. */
export const GUARANTEE_SWEEP_INTERVAL_MS = 60 * 60_000;
/** Guarantees one run looks at per compound. */
export const GUARANTEE_BATCH = 200;

/**
 * Tells who keeps payables (`finance.payables`) that a guarantee still
 * held expires within GUARANTEE_NOTICE_DAYS of the compound's today (ADR
 * 0089), once (`expiry_alerted_at`): a rerun never tells twice. Each
 * guarantee in a transaction of its own, under its row lock, deciding by
 * what it reads after the lock. No amount in the notice.
 */
@Injectable()
export class GuaranteeSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly settings: TenantSettingsService,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(GUARANTEE_SWEEP, () => this.run(), {
      intervalMs: GUARANTEE_SWEEP_INTERVAL_MS,
    });
  }

  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const today = await this.today(tx, tenantId);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM finance_vendor_guarantees
           WHERE status = 'held' AND expiry_alerted_at IS NULL
             AND expires_on >= ${today}::date
             AND expires_on - ${GUARANTEE_NOTICE_DAYS}::int <= ${today}::date
           ORDER BY expires_on, id
           LIMIT ${GUARANTEE_BATCH}`;
        return rows.map((r) => r.id);
      },
      (tx, tenantId, id) => this.warn(tx, tenantId, id),
    );
  }

  private async warn(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    await tx.$queryRaw`
      SELECT id FROM finance_vendor_guarantees WHERE id = ${id}::uuid FOR UPDATE`;
    const g = await tx.financeVendorGuarantee.findUnique({ where: { id } });
    if (!g || g.status !== 'held' || g.expiryAlertedAt) return 0;
    const today = await this.today(tx, tenantId);
    const expiresOn = fromDate(g.expiresOn);
    if (expiresOn < today || addDays(expiresOn, -GUARANTEE_NOTICE_DAYS) > today)
      return 0;
    await tx.financeVendorGuarantee.update({
      where: { id },
      data: { expiryAlertedAt: await dbNow(tx) },
    });
    const keepers = await this.staff.holding(tx, 'finance.payables');
    await this.notifier.notify(
      tx,
      keepers.map((k) => k.id),
      {
        kind: 'vendor_guarantee.expiring',
        params: { guaranteeKind: g.kind, expiresOn },
        targetId: id,
      },
    );
    return 1;
  }

  private async today(tx: TenantTxClient, tenantId: string): Promise<string> {
    const { timezone } = await this.settings.inTx(tx, tenantId);
    return localToday(tx, timezone);
  }
}
