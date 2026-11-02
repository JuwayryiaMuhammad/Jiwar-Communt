import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** Experience and recovery (ADR 0082) as the API suites see it: B's rows. */
export interface M210World {
  /** An open recovery case for B's home unit. */
  bExperienceCaseId: string;
  /** A compensation proposed on it. */
  bCompensationId: string;
  /** A service promise of B's. */
  bServicePromiseId: string;
}

export async function m210World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
  bUnitId: string,
): Promise<M210World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const now = new Date();
      const caseId = newId();
      await tx.experienceCase.create({
        data: {
          id: caseId,
          tenantId: b.tenantId,
          number: 1,
          unitId: bUnitId,
          kind: 'recovery',
          origin: 'manual',
          openedById: b.ids.manager,
          openedAt: now,
        },
      });
      const compensationId = newId();
      await tx.experienceCompensation.create({
        data: {
          id: compensationId,
          tenantId: b.tenantId,
          caseId,
          unitId: bUnitId,
          kind: 'apology',
          failureCode: 'other',
          proposedById: b.ids.manager,
          proposedAt: now,
        },
      });
      const promiseId = newId();
      await tx.servicePromise.create({
        data: {
          id: promiseId,
          tenantId: b.tenantId,
          titleEn: 'World promise',
          titleAr: 'وعد',
          createdById: b.ids.manager,
          createdAt: now,
          updatedAt: now,
        },
      });
      return {
        bExperienceCaseId: caseId,
        bCompensationId: compensationId,
        bServicePromiseId: promiseId,
      };
    }),
  );
}
