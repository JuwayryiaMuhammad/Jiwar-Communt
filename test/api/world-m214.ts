import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { daysLater } from '../setup/compound-clock';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** The spaces (ADR 0084) as the API suites see them: B's rows. */
export interface M214World {
  bHolidayId: string;
  bFloorPlanId: string;
  bSpaceUseId: string;
}

export async function m214World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
  ids: { buildingId: string; unitId: string; commonAreaId: string },
): Promise<M214World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const now = new Date();
      const holiday = await tx.compoundHoliday.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          day: new Date('2027-01-07T00:00:00.000Z'),
          nameEn: 'World feast',
          nameAr: 'عيد',
        },
      });
      const fileId = newId();
      await tx.storedFile.create({
        data: {
          id: fileId,
          tenantId: b.tenantId,
          purpose: 'floor_plan',
          contentType: 'image/png',
          sizeBytes: 100,
          status: 'ready',
          uploadExpiresAt: now,
          finalizedAt: now,
          attachedAt: now,
        },
      });
      const plan = await tx.floorPlan.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          buildingId: ids.buildingId,
          floor: 1,
          fileId,
          createdAt: now,
        },
      });
      const startsAt = daysLater(5);
      const use = await tx.spaceUseRequest.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          commonAreaId: ids.commonAreaId,
          unitId: ids.unitId,
          requestedById: b.ids.manager,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          purpose: 'World use',
          createdAt: now,
        },
      });
      return {
        bHolidayId: holiday.id,
        bFloorPlanId: plan.id,
        bSpaceUseId: use.id,
      };
    }),
  );
}
