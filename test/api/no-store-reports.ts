import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../src/core/database/tenant-tx.service';
import { COMPOUND_EXPORT_BUILD_SWEEP } from '../../src/core/reports/compound-exports.service';
import { ReportSchedulesService } from '../../src/core/reports/report-schedules.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { day, daysLater } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of the reports platform (ADR 0086), in A. */
export function reportsCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const manager = (path: string) =>
    call(world(), 'GET', path, { token: world().a.tokens.manager });
  const inA = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    world().helpers.asManager(world().a, () =>
      world().h.moduleRef.get(TenantTx).withTenantTx(fn),
    );
  return {
    'GET /staff/reports/export': () =>
      manager(
        `/staff/reports/export?report=maintenance_spend&format=csv&from=${day(-30)}&to=${day(0)}`,
      ),
    'GET /staff/report-runs/{id}/download': async () => {
      const a = world().a;
      const schedule = await inA((tx) =>
        tx.reportSchedule.create({
          data: {
            id: newId(),
            tenantId: a.tenantId,
            reportKey: 'maintenance_spend',
            cadence: 'daily',
            format: 'csv',
            createdById: a.ids.manager,
            createdAt: daysLater(-2),
          },
        }),
      );
      await inA((tx) =>
        world().h.moduleRef.get(ReportSchedulesService).runIn(tx, a.tenantId),
      );
      const run = await inA((tx) =>
        tx.reportRun.findFirstOrThrow({ where: { scheduleId: schedule.id } }),
      );
      return manager(`/staff/report-runs/${run.id}/download`);
    },
    'GET /staff/compound-exports/{id}/download': async () => {
      const a = world().a;
      const id = newId();
      await inA((tx) =>
        tx.compoundExport.create({
          data: {
            id,
            tenantId: a.tenantId,
            requestedByAccountId: a.ids.manager,
            requestedAt: daysLater(-2),
          },
        }),
      );
      const sweep = world().h.moduleRef.get(SweepRunner);
      while ((await sweep.run(COMPOUND_EXPORT_BUILD_SWEEP, new Date())) > 0);
      return manager(`/staff/compound-exports/${id}/download`);
    },
  };
}
