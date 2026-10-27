import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { addDays, dateColumn, ofDateColumn } from '../schedules/local-dates';

export const WARRANTY_SWEEP = 'maintenance.asset_warranty';
/** Warranties end on a day: an hourly look is soon enough. */
export const WARRANTY_SWEEP_INTERVAL_MS = 60 * 60_000;
/** How far ahead a warranty's end is announced, in the compound's days. */
export const WARRANTY_NOTICE_DAYS = 30;
/** Assets one run looks at per compound. */
export const WARRANTY_BATCH = 200;

/**
 * Warns who keeps the register that an asset's warranty ends within
 * WARRANTY_NOTICE_DAYS of the compound's today (ADR 0064): once per end
 * date (`warranty_alerted_for`), so a changed date is announced again and
 * a rerun never twice. Each asset in a transaction of its own, under its
 * row lock, deciding by what it reads after the lock.
 */
@Injectable()
export class WarrantySweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly calendar: CompoundCalendar,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(WARRANTY_SWEEP, () => this.run(), {
      intervalMs: WARRANTY_SWEEP_INTERVAL_MS,
    });
  }

  /** Warnings sent across the compounds. */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const { today } = await this.calendar.now(tx, tenantId);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM assets
           WHERE status <> 'retired'
             AND warranty_ends_on BETWEEN ${dateColumn(today)}::date
                                      AND ${dateColumn(addDays(today, WARRANTY_NOTICE_DAYS))}::date
             AND warranty_alerted_for IS DISTINCT FROM warranty_ends_on
           ORDER BY warranty_ends_on, id
           LIMIT ${WARRANTY_BATCH}`;
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
    await tx.$queryRaw`SELECT id FROM assets WHERE id = ${id}::uuid FOR UPDATE`;
    const asset = await tx.asset.findUnique({ where: { id } });
    const { today } = await this.calendar.now(tx, tenantId);
    if (
      !asset ||
      asset.status === 'retired' ||
      asset.warrantyEndsOn === null ||
      (asset.warrantyAlertedFor !== null &&
        asset.warrantyAlertedFor.getTime() === asset.warrantyEndsOn.getTime())
    )
      return 0;
    const endsOn = ofDateColumn(asset.warrantyEndsOn);
    if (endsOn < today || endsOn > addDays(today, WARRANTY_NOTICE_DAYS))
      return 0;
    await tx.asset.update({
      where: { id },
      data: { warrantyAlertedFor: asset.warrantyEndsOn },
    });
    const keepers = await tx.account.findMany({
      where: {
        status: 'active',
        role: { permissions: { some: { permission: 'assets.manage' } } },
      },
      select: { id: true },
    });
    await this.notifier.notify(
      tx,
      keepers.map((k) => k.id),
      {
        kind: 'asset.warranty_expiring',
        params: { assetRef: asset.code, endsOn },
        targetId: id,
      },
    );
    return 1;
  }
}
