import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** Dispatch depth (ADR 0076) as the API suites see it: B's rows. */
export interface M22World {
  /** An open claim under B's asset's warranty. */
  bWarrantyClaimId: string;
}

export async function m22World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
  bAssetId: string,
): Promise<M22World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const claim = await tx.warrantyClaim.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          assetId: bAssetId,
          description: 'World claim',
          openedById: b.ids.manager,
          openedAt: new Date(),
        },
      });
      return { bWarrantyClaimId: claim.id };
    }),
  );
}
