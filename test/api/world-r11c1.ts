import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import { dbDate } from '../setup/compound-clock';
import {
  activateBudget,
  batchRow,
  budgetRow,
  invoiceRow,
} from '../setup/finance-rows';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/**
 * Money and the unit (ADR 0069) as the API suites see it: B's rows, the
 * foreign ids of the matrix.
 */
export interface R11c1World {
  /** A spending report of B's, of an approved budget of its own. */
  bSpendingReportId: string;
  /** A plan request B's owner made on an invoice of B's home (withdrawn). */
  bPlanRequestId: string;
  /** A collector visit B's owner asked for (cancelled by them). */
  bCollectorVisitId: string;
}

export async function r11c1World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<R11c1World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const budgetId = await budgetRow(tx, {
        tenantId: b.tenantId,
        createdById: b.ids.manager,
      });
      await activateBudget(tx, {
        tenantId: b.tenantId,
        budgetId,
        raisedById: b.ids.manager,
      });
      const bSpendingReportId = newId();
      await tx.financeSpendingReport.create({
        data: {
          id: bSpendingReportId,
          tenantId: b.tenantId,
          budgetId,
          fiscalYear: 2031,
          startsOn: dbDate('2031-01-01'),
          asOf: dbDate('2031-03-31'),
          publishedBy: b.ids.manager,
        },
      });
      const invoiceId = await invoiceRow(tx, {
        tenantId: b.tenantId,
        unitId: b.homeUnitId,
        batchId: await batchRow(tx, {
          tenantId: b.tenantId,
          unitId: b.homeUnitId,
          createdById: b.ids.manager,
        }),
        createdById: b.ids.manager,
      });
      const bPlanRequestId = newId();
      await tx.instalmentPlanRequest.create({
        data: {
          id: bPlanRequestId,
          tenantId: b.tenantId,
          invoiceId,
          unitId: b.homeUnitId,
          requestedById: b.ids.owner,
          months: 3,
          status: 'withdrawn',
          decidedAt: new Date(),
        },
      });
      const bCollectorVisitId = newId();
      await tx.collectorVisit.create({
        data: {
          id: bCollectorVisitId,
          tenantId: b.tenantId,
          unitId: b.homeUnitId,
          requestedById: b.ids.owner,
          windowStartsAt: new Date('2099-01-05T08:00:00+02:00'),
          windowEndsAt: new Date('2099-01-05T10:00:00+02:00'),
          status: 'cancelled',
          cancelSide: 'resident',
          closedAt: new Date(),
        },
      });
      return { bSpendingReportId, bPlanRequestId, bCollectorVisitId };
    }),
  );
}
