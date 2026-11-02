import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import { daysLater } from '../setup/compound-clock';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** The maintenance analytics (ADR 0081) as the API suites see it: B's rows. */
export interface M213World {
  /** An open plan suggestion on B's asset. */
  bPlanSuggestionId: string;
  /** An open community case in a building of B's. */
  bMaintenanceCaseId: string;
}

export async function m213World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
  bAssetId: string,
): Promise<M213World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const category = await tx.ticketCategory.findFirstOrThrow({
        where: { key: 'plumbing' },
      });
      const suggestion = await tx.maintenancePlanSuggestion.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          assetId: bAssetId,
          categoryId: category.id,
          ticketCount: 3,
          windowDays: 90,
          firstTicketAt: daysLater(-7),
          lastTicketAt: new Date(),
          createdAt: new Date(),
        },
      });
      const building = await tx.building.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          name: `World tower ${newId().slice(-6)}`,
        },
      });
      const c = await tx.maintenanceCase.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          categoryId: category.id,
          buildingId: building.id,
          openedAt: new Date(),
        },
      });
      return { bPlanSuggestionId: suggestion.id, bMaintenanceCaseId: c.id };
    }),
  );
}
