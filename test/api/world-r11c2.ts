import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import { listingRow } from '../setup/market-rows';
import type { Side } from './world';

/**
 * Community (ADR 0071) as the API suites see it: B's rows, the foreign ids
 * of the matrix.
 */
export interface R11c2World {
  /** A live listing B's owner put on B's market. */
  bListingId: string;
}

export async function r11c2World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<R11c2World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => ({
      bListingId: await listingRow(tx, {
        tenantId: b.tenantId,
        sellerId: b.ids.owner,
        sellerUnitId: b.homeUnitId,
      }),
    })),
  );
}
