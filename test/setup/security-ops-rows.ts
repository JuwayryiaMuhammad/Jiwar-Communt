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

let plates = 0;

/** A live ban of a plate of its own (one live entry per plate). */
export async function blocklistRow(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.blocklistEntry.create({
    data: {
      id,
      tenantId: r.tenantId,
      kind: 'ban',
      subject: 'plate',
      plate: `ROW ${(++plates % 1e6).toString()}`,
      reasonCode: 'other',
      createdById: r.createdById,
    },
  });
  return id;
}

/** A live watch of a person, with a made-up ID hash of its own. */
export async function personRow(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.blocklistEntry.create({
    data: {
      id,
      tenantId: r.tenantId,
      kind: 'watch',
      subject: 'person',
      fullName: 'Row Person',
      idHash: id.replace(/-/g, '').padEnd(64, '0'),
      reasonCode: 'other',
      createdById: r.createdById,
    },
  });
  return id;
}

/** A plate the gate met (refused at an entry). */
export async function matchRow(
  tx: TenantTxClient,
  r: { tenantId: string; entryId: string; actorId: string; gateId: string },
): Promise<string> {
  const id = newId();
  await tx.blocklistMatch.create({
    data: {
      id,
      tenantId: r.tenantId,
      entryId: r.entryId,
      kind: 'ban',
      source: 'entry',
      gateId: r.gateId,
      actorAccountId: r.actorId,
      outcome: 'refused',
    },
  });
  return id;
}

/** A pass security refused, once: its pointer (the subject id). */
export async function refusalRow(
  tx: TenantTxClient,
  r: { tenantId: string },
): Promise<string> {
  const subjectId = newId();
  await tx.securityRefusal.create({
    data: { tenantId: r.tenantId, subjectType: 'visitor_pass', subjectId },
  });
  return subjectId;
}
