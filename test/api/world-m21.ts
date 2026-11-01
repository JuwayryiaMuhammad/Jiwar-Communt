import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import { buildingRow, unitImportRow } from '../setup/units-rows';
import type { Side } from './world';

/**
 * The unit register (ADR 0072) as the API suites see it: B's rows, the
 * foreign ids of the matrix.
 */
export interface M21World {
  /** A building of B's no unit names. */
  bBuildingId: string;
  /** A valid units import of B's manager. */
  bUnitImportId: string;
}

export async function m21World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<M21World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => ({
      bBuildingId: await buildingRow(tx, b.tenantId),
      bUnitImportId: await unitImportRow(tx, {
        tenantId: b.tenantId,
        createdById: b.ids.manager,
      }),
    })),
  );
}
