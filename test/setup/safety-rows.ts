import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { required } from './test-env';

// ============================================================================
// Emergencies and gate services rows written straight into the tables (ADR
// 0047), for the suites that test the database itself: the schema and
// isolation suites. Each returns the row's id.
// ============================================================================

let next = 1;
/** A number nobody else in the run takes (the unique per compound). */
const number = () => 900_000 + next++ + Math.floor(Math.random() * 90_000);

export async function placeRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.place.create({
    data: {
      id,
      tenantId,
      nameEn: `Row place ${id.slice(-8)}`,
      nameAr: `مكان ${id.slice(-8)}`,
    },
  });
  return id;
}

export async function counterRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  await tx.safetyCounter.upsert({
    where: { tenantId_series: { tenantId, series: 'emergency' } },
    create: { tenantId, series: 'emergency', lastNumber: 1 },
    update: {},
  });
  return tenantId;
}

export async function emergencyRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    unitId: string;
    reportedById: string;
    type?: 'medical' | 'fire' | 'security' | 'facilities';
  },
): Promise<string> {
  const id = newId();
  await tx.emergency.create({
    data: {
      id,
      tenantId: input.tenantId,
      number: number(),
      unitId: input.unitId,
      type: input.type ?? 'medical',
      reportedById: input.reportedById,
      respondersNotified: 0,
    },
  });
  return id;
}

export async function familyAlertRow(
  tx: TenantTxClient,
  input: { tenantId: string; emergencyId: string; accountId: string },
): Promise<string> {
  await tx.emergencyFamilyAlert.create({ data: input });
  return input.emergencyId;
}

/**
 * TEST-ONLY time machine: moves an emergency's report `ms` into the past
 * over a superuser connection with `session_replication_role = replica`,
 * which skips the trigger that keeps it. src/ cannot import it.
 */
export async function rewindEmergency(id: string, ms: number): Promise<void> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      `UPDATE emergencies SET reported_at = reported_at - $2::interval WHERE id = $1`,
      [id, `${ms} milliseconds`],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}
