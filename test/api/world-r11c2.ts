import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import {
  listingRow,
  marketReportRow,
  partnerOfferRow,
  shopRow,
} from '../setup/market-rows';
import type { Side } from './world';

/**
 * Community (ADR 0071) as the API suites see it: B's rows, the foreign ids
 * of the matrix.
 */
export interface R11c2World {
  /** A live listing B's owner put on B's market. */
  bListingId: string;
  /** B's owner's open shop. */
  bShopId: string;
  /** B's tenant's report of B's listing. */
  bMarketReportId: string;
  /** An offer of B's partner, in force. */
  bPartnerOfferId: string;
}

export async function r11c2World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
  bPartnerId: string,
): Promise<R11c2World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const bListingId = await listingRow(tx, {
        tenantId: b.tenantId,
        sellerId: b.ids.owner,
        sellerUnitId: b.homeUnitId,
      });
      return {
        bListingId,
        bMarketReportId: await marketReportRow(tx, {
          tenantId: b.tenantId,
          listingId: bListingId,
          reporterId: b.ids.tenant,
          reporterUnitId: b.rentedUnitId,
        }),
        bShopId: await shopRow(tx, {
          tenantId: b.tenantId,
          ownerId: b.ids.owner,
          ownerUnitId: b.homeUnitId,
        }),
        bPartnerOfferId: await partnerOfferRow(tx, {
          tenantId: b.tenantId,
          partnerId: bPartnerId,
          createdById: b.ids.manager,
        }),
      };
    }),
  );
}
