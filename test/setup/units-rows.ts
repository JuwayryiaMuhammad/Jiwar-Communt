import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { uniqueSuffix } from './fixtures';

/** A building of the compound (ADR 0072), by name. */
export async function buildingRow(
  tx: TenantTxClient,
  tenantId: string,
  name = `Building ${uniqueSuffix()}`,
): Promise<string> {
  const id = newId();
  await tx.building.create({ data: { id, tenantId, name } });
  return id;
}
