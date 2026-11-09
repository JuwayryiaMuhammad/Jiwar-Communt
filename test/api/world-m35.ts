import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import { glAccountId, glEntryId, glManualEntryRow } from '../setup/gl-rows';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** The general ledger (ADR 0092) as the API suites see it: B's rows. */
export interface M35World {
  /** B's suspense account: postable, kept by no register. */
  bGlAccountId: string;
  /** One of B's posted entries (its treasury's or its payments'). */
  bGlEntryId: string;
  /** A pending manual entry of B's. */
  bGlManualEntryId: string;
}

export async function m35World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<M35World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => ({
      bGlAccountId: await glAccountId(tx, b.tenantId, 'suspense'),
      bGlEntryId: await glEntryId(tx),
      bGlManualEntryId: await glManualEntryRow(tx, {
        tenantId: b.tenantId,
        createdById: b.ids.manager,
      }),
    })),
  );
}
