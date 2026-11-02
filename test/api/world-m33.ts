import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** The reports platform (ADR 0086) as the API suites see it: B's rows. */
export interface M33World {
  bReportScheduleId: string;
  /** An expired run of it: never a file to fetch. */
  bReportRunId: string;
  /** A draft capital plan with one line. */
  bCapitalPlanId: string;
  bCapitalPlanLineId: string;
  /** A failed export of the compound. */
  bCompoundExportId: string;
}

export async function m33World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<M33World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const now = new Date();
      const schedule = await tx.reportSchedule.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          reportKey: 'maintenance_spend',
          cadence: 'monthly',
          format: 'csv',
          createdById: b.ids.manager,
          createdAt: now,
        },
      });
      const run = await tx.reportRun.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          scheduleId: schedule.id,
          reportKey: 'maintenance_spend',
          periodFrom: new Date('2026-01-01'),
          periodTo: new Date('2026-01-31'),
          format: 'csv',
          rows: 0,
          status: 'expired',
          writtenAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
          expiredAt: now,
        },
      });
      const plan = await tx.capitalPlan.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          year: 2099,
          createdById: b.ids.manager,
          createdAt: now,
        },
      });
      const line = await tx.capitalPlanLine.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          planId: plan.id,
          description: 'World line',
          amount: '100.00',
          source: 'manual',
          createdAt: now,
        },
      });
      const exp = await tx.compoundExport.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          requestedByAccountId: b.ids.manager,
          requestedAt: now,
          status: 'failed',
          endedAt: now,
          failureCode: 'build_failed',
        },
      });
      return {
        bReportScheduleId: schedule.id,
        bReportRunId: run.id,
        bCapitalPlanId: plan.id,
        bCapitalPlanLineId: line.id,
        bCompoundExportId: exp.id,
      };
    }),
  );
}
