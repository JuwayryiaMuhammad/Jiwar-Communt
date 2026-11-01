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

/** A ready `data_import` file of the compound, attached (a sheet). */
export async function sheetFileRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose: 'data_import',
      contentType: 'text/csv',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}

/** A valid units import of the compound (ADR 0072), on its own sheet. */
export async function unitImportRow(
  tx: TenantTxClient,
  o: { tenantId: string; createdById: string; fileId?: string },
): Promise<string> {
  const id = newId();
  await tx.unitImport.create({
    data: {
      id,
      tenantId: o.tenantId,
      kind: 'units',
      fileId: o.fileId ?? (await sheetFileRow(tx, o.tenantId)),
      status: 'valid',
      rowCount: 1,
      errorCount: 0,
      createdById: o.createdById,
      createdAt: new Date(),
    },
  });
  return id;
}
