import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// Raw rows of the security tables of ADR 0053, for the schema and isolation
// suites: the shortest valid row of each.

const HOUR = 3_600_000;

/**
 * A lockdown of a gate (or of all, `gateId: null`). Ended an hour after it
 * started unless `live`: one live per scope, so a suite makes as many ended
 * ones as it likes.
 */
export async function lockdownRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    gateId: string | null;
    guardId: string;
    shiftId: string;
    live?: boolean;
  },
): Promise<string> {
  const id = newId();
  const startedAt = new Date(Date.now() - 2 * HOUR);
  await tx.gateLockdown.create({
    data: {
      id,
      tenantId: r.tenantId,
      gateId: r.gateId,
      reasonCode: 'drill',
      startedById: r.guardId,
      startedShiftId: r.shiftId,
      startedAt,
      ...(r.live
        ? {}
        : {
            endedAt: new Date(startedAt.getTime() + HOUR),
            endedById: r.guardId,
            endReason: 'drill_over',
          }),
    },
  });
  return id;
}

/** An ambulance let through a locked gate. */
export async function overrideRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    lockdownId: string;
    gateId: string;
    shiftId: string;
    guardId: string;
  },
): Promise<string> {
  const id = newId();
  await tx.gateLockdownOverride.create({
    data: {
      id,
      tenantId: r.tenantId,
      lockdownId: r.lockdownId,
      gateId: r.gateId,
      shiftId: r.shiftId,
      guardAccountId: r.guardId,
      kind: 'ambulance',
      occurredAt: new Date(),
    },
  });
  return id;
}
