import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import { dbDate } from '../setup/compound-clock';
import { activateBudget, budgetRow } from '../setup/finance-rows';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/**
 * Money and the unit (ADR 0069) as the API suites see it: B's rows, the
 * foreign ids of the matrix.
 */
export interface R11c1World {
  /** A spending report of B's, of an approved budget of its own. */
  bSpendingReportId: string;
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
      return { bSpendingReportId };
    }),
  );
}
