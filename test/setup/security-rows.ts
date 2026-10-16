import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// Raw rows of the guard shifts and tasks tables (ADR 0050), for the schema
// and isolation suites: the shortest valid row of each.

const HOUR = 3_600_000;

export async function gateRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.gate.create({
    data: { id, tenantId, name: `Gate ${id}`, kind: 'mixed' },
  });
  return id;
}

export async function templateRow(
  tx: TenantTxClient,
  r: { tenantId: string; guardId: string; gateId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.guardRosterTemplate.create({
    data: {
      id,
      tenantId: r.tenantId,
      guardAccountId: r.guardId,
      gateId: r.gateId,
      schedule: { days: [1], windows: [{ from: '06:00', to: '14:00' }] },
      effectiveFrom: new Date('2030-01-01T00:00:00Z'),
      createdById: r.createdById,
    },
  });
  return id;
}

/** A single slot, `inHours` from now, an hour long. */
export async function slotRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    guardId: string;
    gateId: string;
    createdById: string;
    inHours?: number;
  },
): Promise<string> {
  const id = newId();
  const startsAt = new Date(Date.now() + (r.inHours ?? 24) * HOUR);
  await tx.guardRosterSlot.create({
    data: {
      id,
      tenantId: r.tenantId,
      guardAccountId: r.guardId,
      gateId: r.gateId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR),
      createdById: r.createdById,
    },
  });
  return id;
}
