import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow, localToday } from '../db-clock';
import { CASH_FLOW_PERIODS, CASH_LOW_QUIET_MS } from './cash-flow-rules';
import { CashFlowService } from './cash-flow.service';

export const CASH_FLOW_SWEEP = 'finance.cash_flow';
/** The forecast moves with the day's money: an hourly look is soon enough. */
export const CASH_FLOW_SWEEP_INTERVAL_MS = 60 * 60_000;

interface FloorRow {
  cash_minimum: Prisma.Decimal | null;
  cash_low_since: Date | null;
  cash_low_told_at: Date | null;
}

/**
 * The minimum-cash notice (ADR 0091). Every hour, in each active compound
 * with a floor, under its finance settings row's lock (the floor's change
 * takes the same), the default forecast (13 weeks) is read: the cash below
 * the floor now, or a week closing below it, is a dip. A dip is told to
 * the `finance.cashflow` holders once (`finance.cash_low`, the first day
 * below it, never an amount); it eases silently when the cash and the
 * forecast are back above; a new dip within a day of the last notice is
 * told when the day is up, if it lasts. Two sweeps at once meet on the
 * row: the second finds the dip told.
 */
@Injectable()
export class CashFlowSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly settings: TenantSettingsService,
    private readonly cashFlow: CashFlowService,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(CASH_FLOW_SWEEP, () => this.run(), {
      intervalMs: CASH_FLOW_SWEEP_INTERVAL_MS,
    });
  }

  /** Dips told across the compounds. */
  run(): Promise<number> {
    return this.sweep.forEachTenant((tx, tenantId) => this.check(tx, tenantId));
  }

  private async check(tx: TenantTxClient, tenantId: string): Promise<number> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant?.status !== 'active') return 0;
    const [row] = await tx.$queryRaw<FloorRow[]>`
      SELECT cash_minimum, cash_low_since, cash_low_told_at
        FROM finance_settings WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    if (!row || row.cash_minimum === null) return 0;
    const { timezone } = await this.settings.inTx(tx, tenantId);
    const today = await localToday(tx, timezone);
    const f = await this.cashFlow.read(tx, {
      today,
      timeZone: timezone,
      by: 'week',
      count: CASH_FLOW_PERIODS.week.default,
    });
    const now = await dbNow(tx);
    if (!f.belowMinimumNow && f.periodsBelowMinimum === 0) {
      if (row.cash_low_since)
        await tx.financeSettings.update({
          where: { tenantId },
          data: { cashLowSince: null },
        });
      return 0;
    }
    const since = row.cash_low_since ?? now;
    const toldAt = row.cash_low_told_at;
    const told = toldAt !== null && toldAt >= since;
    const quiet =
      toldAt !== null && now.getTime() - toldAt.getTime() < CASH_LOW_QUIET_MS;
    const tell = !told && !quiet;
    if (!row.cash_low_since || tell)
      await tx.financeSettings.update({
        where: { tenantId },
        data: { cashLowSince: since, ...(tell ? { cashLowToldAt: now } : {}) },
      });
    if (!tell) return 0;
    const to = await this.staff.holding(tx, 'finance.cashflow');
    await this.notifier.notify(
      tx,
      to.map((r) => r.id),
      {
        kind: 'finance.cash_low',
        params: {
          belowFrom: f.belowMinimumNow ? today : f.firstBelowMinimum!,
        },
        targetId: tenantId,
      },
    );
    return 1;
  }
}
