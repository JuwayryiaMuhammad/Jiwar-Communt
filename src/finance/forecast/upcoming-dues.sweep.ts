import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { addDays } from '../../core/common/slots/day-slots';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { asDate, localToday } from '../db-clock';
import { money, ZERO } from '../money';
import {
  monthOf,
  monthPlus,
  rising,
  RISING_PAST_MONTHS,
} from './forecast-rules';
import { UpcomingDuesService } from './upcoming-dues.service';

export const UPCOMING_DUES_SWEEP = 'finance.dues';
/** Read a few times a day: a unit is told once a month at most. */
const EVERY = 6 * 3_600_000;

/**
 * The dues-rising notice (ADR 0069), only where the compound turned it on:
 * a unit whose next month asks more than one and a half times the mean of
 * the six months before (what was issued to it, instalments aside) is told
 * once that month — the (unit, month) row is claimed first, so two sweeps
 * tell once. To who sees its money now; the month, never an amount.
 */
@Injectable()
export class UpcomingDuesSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly settings: TenantSettingsService,
    private readonly dues: UpcomingDuesService,
    private readonly community: CommunityFinancePort,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(UPCOMING_DUES_SWEEP, () => this.run(), {
      intervalMs: EVERY,
    });
  }

  /** Units told. */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const s = await tx.financeSettings.findUnique({
          where: { tenantId },
          select: { duesNotice: true },
        });
        if (!s?.duesNotice) return [];
        const { timezone } = await this.settings.inTx(tx, tenantId);
        const next = monthPlus(monthOf(await localToday(tx, timezone)), 1);
        const rows = await tx.$queryRaw<{ unit_id: string }[]>`
          SELECT DISTINCT o.unit_id FROM unit_occupancies o
           WHERE o.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM finance_dues_notices n
                              WHERE n.tenant_id = o.tenant_id AND n.unit_id = o.unit_id
                                AND n.month = ${next})`;
        return rows.map((r) => ({ unitId: r.unit_id, month: next }));
      },
      async (tx, tenantId, item) => {
        const { timezone } = await this.settings.inTx(tx, tenantId);
        const today = await localToday(tx, timezone);
        const lastDueOn = addDays(`${monthPlus(item.month, 1)}-01`, -1);
        const { byMonth } = await this.dues.duesOf(
          tx,
          item.unitId,
          today,
          lastDueOn,
        );
        const m = byMonth.get(item.month);
        const next = m ? m.invoiced.add(m.projected) : ZERO;
        const from = monthPlus(item.month, -RISING_PAST_MONTHS - 1);
        const issued = await tx.$queryRaw<
          { month: string; total: Prisma.Decimal }[]
        >`
          SELECT to_char(i.issued_on, 'YYYY-MM') AS month, SUM(i.total) AS total
            FROM invoices i
           WHERE i.unit_id = ${item.unitId}::uuid
             AND i.instalment_plan_id IS NULL
             AND i.issued_on >= ${asDate(`${from}-01`)}::date
             AND i.issued_on < ${asDate(`${monthPlus(item.month, -1)}-01`)}::date
           GROUP BY 1`;
        const past = Array.from({ length: RISING_PAST_MONTHS }, (_, i) => {
          const month = monthPlus(from, i);
          const row = issued.find((r) => r.month === month);
          return row ? money(row.total) : ZERO;
        });
        if (!rising(next, past)) return 0;
        const claimed = await tx.$queryRaw<{ unit_id: string }[]>`
          INSERT INTO finance_dues_notices (tenant_id, unit_id, month)
          VALUES (${tenantId}::uuid, ${item.unitId}::uuid, ${item.month})
          ON CONFLICT DO NOTHING RETURNING unit_id`;
        if (!claimed.length) return 0;
        const to = await this.community.financeHolders(tx, item.unitId);
        if (!to.length) return 0;
        await this.notifier.notify(tx, to, {
          kind: 'finance.dues_rising',
          params: { month: item.month },
          targetId: item.unitId,
        });
        return 1;
      },
    );
  }
}
