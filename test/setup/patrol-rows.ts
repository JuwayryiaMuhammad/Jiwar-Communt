import { createHash } from 'node:crypto';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// Raw rows of the patrol tables (ADR 0052), for the schema and isolation
// suites: the shortest valid row of each.

/** A token hash's shape: what the column takes (the hash of anything). */
export const rowHash = (seed: string) =>
  createHash('sha256').update(seed).digest('hex');

/** A checkpoint in service at a gate (or a zone), without a position. */
export async function checkpointRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    gateId?: string;
    placeId?: string;
    createdById: string;
  },
): Promise<string> {
  const id = newId();
  await tx.patrolCheckpoint.create({
    data: {
      id,
      tenantId: r.tenantId,
      gateId: r.placeId ? null : (r.gateId ?? null),
      placeId: r.placeId ?? null,
      nameEn: `Row point ${id.slice(-8)}`,
      nameAr: `نقطة ${id.slice(-8)}`,
      tokenHash: rowHash(id),
      tokenIssuedAt: new Date(),
      createdById: r.createdById,
    },
  });
  return id;
}

/**
 * A route in service at a gate (or a zone), its first version walking
 * `checkpointIds` in order, unscheduled unless `schedule` is given.
 */
export async function routeRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    gateId?: string;
    placeId?: string;
    createdById: string;
    checkpointIds: string[];
    expectedMinutes?: number;
    ordered?: boolean;
    schedule?: { days: number[]; times: string[] };
  },
): Promise<{ routeId: string; versionId: string }> {
  const routeId = newId();
  const versionId = newId();
  await tx.patrolRoute.create({
    data: {
      id: routeId,
      tenantId: r.tenantId,
      gateId: r.placeId ? null : (r.gateId ?? null),
      placeId: r.placeId ?? null,
      nameEn: `Row route ${routeId.slice(-8)}`,
      nameAr: `جولة ${routeId.slice(-8)}`,
      createdById: r.createdById,
    },
  });
  await tx.patrolRouteVersion.create({
    data: {
      id: versionId,
      tenantId: r.tenantId,
      routeId,
      number: 1,
      ordered: r.ordered ?? false,
      expectedMinutes: r.expectedMinutes ?? 30,
      schedule: r.schedule,
      createdById: r.createdById,
    },
  });
  await tx.patrolRouteCheckpoint.createMany({
    data: r.checkpointIds.map((checkpointId, i) => ({
      id: newId(),
      tenantId: r.tenantId,
      versionId,
      position: i + 1,
      checkpointId,
    })),
  });
  return { routeId, versionId };
}

/** A version's stop, alone (the isolation suite links it elsewhere). */
export async function routeStopRow(
  tx: TenantTxClient,
  r: { tenantId: string; versionId: string; checkpointId: string },
): Promise<string> {
  const id = newId();
  await tx.patrolRouteCheckpoint.create({
    data: {
      id,
      tenantId: r.tenantId,
      versionId: r.versionId,
      position: 50,
      checkpointId: r.checkpointId,
    },
  });
  return id;
}

let versions = 100;

/** A superseded version of a route (any number of them may exist). */
export async function versionRow(
  tx: TenantTxClient,
  r: { tenantId: string; routeId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.patrolRouteVersion.create({
    data: {
      id,
      tenantId: r.tenantId,
      routeId: r.routeId,
      number: ++versions,
      ordered: false,
      expectedMinutes: 30,
      createdById: r.createdById,
      supersededAt: new Date(),
    },
  });
  return id;
}

/** A scheduled run of a version, a day ahead (`inHours` from now). */
export async function runRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    routeId: string;
    versionId: string;
    gateId: string;
    inHours?: number;
  },
): Promise<string> {
  const id = newId();
  const scheduledStart = new Date(Date.now() + (r.inHours ?? 24) * 3_600_000);
  await tx.patrolRun.create({
    data: {
      id,
      tenantId: r.tenantId,
      routeId: r.routeId,
      versionId: r.versionId,
      gateId: r.gateId,
      kind: 'scheduled',
      plannedAt: scheduledStart,
      scheduledStart,
      windowEndsAt: new Date(scheduledStart.getTime() + 1_800_000),
      status: 'scheduled',
      checkpointsTotal: 1,
    },
  });
  return id;
}

/** A QR scan of a checkpoint on a run, by a guard, now. */
export async function scanRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    runId: string;
    checkpointId: string;
    guardId: string;
  },
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.patrolScan.create({
    data: {
      id,
      tenantId: r.tenantId,
      runId: r.runId,
      checkpointId: r.checkpointId,
      position: 1,
      method: 'qr',
      scannedAt: now,
      receivedAt: now,
      guardAccountId: r.guardId,
    },
  });
  return id;
}

/** A note at a scan, with words. */
export async function noteRow(
  tx: TenantTxClient,
  r: { tenantId: string; runId: string; scanId: string; guardId: string },
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.patrolNote.create({
    data: {
      id,
      tenantId: r.tenantId,
      runId: r.runId,
      scanId: r.scanId,
      outcome: 'all_clear',
      text: 'Row words',
      notedAt: now,
      receivedAt: now,
      guardAccountId: r.guardId,
    },
  });
  return id;
}

export async function notePhotoRow(
  tx: TenantTxClient,
  r: { tenantId: string; noteId: string; fileId: string; uploadedById: string },
): Promise<string> {
  const id = newId();
  await tx.patrolNotePhoto.create({
    data: {
      id,
      tenantId: r.tenantId,
      noteId: r.noteId,
      fileId: r.fileId,
      uploadedById: r.uploadedById,
    },
  });
  return id;
}

/** A point of a run, recorded `msAgo` before now. */
export async function trackRow(
  tx: TenantTxClient,
  r: { tenantId: string; runId: string; guardId: string; msAgo?: number },
): Promise<string> {
  const id = newId();
  const recordedAt = new Date(Date.now() - (r.msAgo ?? 0));
  await tx.patrolTrackPoint.create({
    data: {
      id,
      tenantId: r.tenantId,
      runId: r.runId,
      guardAccountId: r.guardId,
      recordedAt,
      lat: 30.0444,
      lng: 31.2357,
      receivedAt: new Date(),
    },
  });
  return id;
}
