import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { checkpointRow, routeRow, runRow } from './patrol-rows';

// Raw rows of the gate's completion tables (ADR 0056), for the schema and
// isolation suites: the shortest valid row of each. Instants are written
// out, never read from a clock.

export const ROW_T0 = new Date('2026-11-04T10:00:00.000Z');
export const rowAt = (minutes: number) =>
  new Date(ROW_T0.getTime() + minutes * 60_000);

let exceptions = 0;

/** A pending visitor's exception, raised at T0, answer by T0 + 10 min. */
export async function fieldExceptionRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    gateId: string;
    shiftId: string;
    guardId: string;
    unitId: string;
    visitorDetailsId?: string;
  },
): Promise<string> {
  const id = newId();
  await tx.gateFieldException.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: 800_000 + ++exceptions,
      kind: 'visitor_without_pass',
      reasonCode: 'other',
      gateId: r.gateId,
      shiftId: r.shiftId,
      raisedById: r.guardId,
      unitId: r.unitId,
      visitorDetailsId: r.visitorDetailsId ?? null,
      raisedAt: ROW_T0,
      answerBy: rowAt(10),
    },
  });
  return id;
}

/** A visitor's details, expiring in a year from T0. */
export async function visitorDetailsRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.visitorDetails.create({
    data: {
      id,
      tenantId,
      fullName: 'Row visitor',
      vehiclePlate: 'ROW 77',
      expiresAt: rowAt(525_600),
    },
  });
  return id;
}

/** A visitor pass's overstay alert, its entry a made-up id (entries have no keys). */
export async function overstayAlertRow(
  tx: TenantTxClient,
  r: { tenantId: string; gateId: string; unitId: string },
): Promise<string> {
  const entryId = newId();
  await tx.visitOverstayAlert.create({
    data: {
      tenantId: r.tenantId,
      entryId,
      subjectType: 'visitor_pass',
      subjectId: newId(),
      gateId: r.gateId,
      unitId: r.unitId,
      enteredAt: ROW_T0,
      expectedMinutes: 15,
      alertedAt: rowAt(20),
    },
  });
  return entryId;
}

let plates = 0;

/** A tanker inside, come in at T0 at the gate. */
export async function serviceVehicleRow(
  tx: TenantTxClient,
  r: { tenantId: string; gateId: string; shiftId: string; guardId: string },
): Promise<string> {
  const id = newId();
  await tx.serviceVehicleVisit.create({
    data: {
      id,
      tenantId: r.tenantId,
      plate: `ROW ${++plates}`,
      kind: 'tanker',
      company: 'Row Water',
      enteredAt: ROW_T0,
      enteredGateId: r.gateId,
      enteredShiftId: r.shiftId,
      enteredById: r.guardId,
    },
  });
  return id;
}

/** A visitor's photo at an entry of T0, with its ready, attached file. */
export async function entryPhotoRow(
  tx: TenantTxClient,
  r: { tenantId: string; gateId: string; unitId: string; guardId: string },
): Promise<string> {
  const entryId = newId();
  const fileId = newId();
  await tx.storedFile.create({
    data: {
      id: fileId,
      tenantId: r.tenantId,
      purpose: 'visitor_photo',
      contentType: 'image/png',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: ROW_T0,
      finalizedAt: ROW_T0,
      attachedAt: ROW_T0,
    },
  });
  await tx.gateEntryPhoto.create({
    data: {
      tenantId: r.tenantId,
      entryId,
      fileId,
      subjectType: 'visitor_pass',
      subjectId: newId(),
      gateId: r.gateId,
      unitId: r.unitId,
      takenById: r.guardId,
      enteredAt: ROW_T0,
      purgeAfter: rowAt(30 * 24 * 60),
    },
  });
  return entryId;
}

/** An incident's evidence: the photo of an entry. */
export async function evidenceRow(
  tx: TenantTxClient,
  r: { tenantId: string; incidentId: string; entryId: string; byId: string },
): Promise<string> {
  const id = newId();
  await tx.incidentEvidence.create({
    data: {
      id,
      tenantId: r.tenantId,
      incidentId: r.incidentId,
      kind: 'visitor_photo',
      entryId: r.entryId,
      linkedById: r.byId,
      linkedAt: rowAt(60),
    },
  });
  return id;
}

/** The resident vehicles counted in at a gate on T0's day: the gate's id. */
export async function vehicleCountRow(
  tx: TenantTxClient,
  r: { tenantId: string; gateId: string },
): Promise<string> {
  await tx.gateVehicleCount.create({
    data: {
      tenantId: r.tenantId,
      day: new Date('2026-11-04T00:00:00.000Z'),
      gateId: r.gateId,
      direction: 'in',
      count: 3,
    },
  });
  return r.gateId;
}

/** A scheduled patrol run of a route of its own at a gate: the run's id. */
export async function patrolRunRow(
  tx: TenantTxClient,
  r: { tenantId: string; gateId: string; createdById: string },
): Promise<string> {
  const checkpointId = await checkpointRow(tx, r);
  const { routeId, versionId } = await routeRow(tx, {
    ...r,
    checkpointIds: [checkpointId],
  });
  return runRow(tx, {
    tenantId: r.tenantId,
    routeId,
    versionId,
    gateId: r.gateId,
  });
}

/** An open geofence exit of a run, its guard out since T0. */
export async function geofenceExitRow(
  tx: TenantTxClient,
  r: { tenantId: string; runId: string; guardId: string },
): Promise<string> {
  const id = newId();
  await tx.patrolGeofenceExit.create({
    data: {
      id,
      tenantId: r.tenantId,
      runId: r.runId,
      guardAccountId: r.guardId,
      leftAt: ROW_T0,
    },
  });
  return id;
}

/** An incident's evidence: the track of a run. */
export async function trackEvidenceRow(
  tx: TenantTxClient,
  r: { tenantId: string; incidentId: string; runId: string; byId: string },
): Promise<string> {
  const id = newId();
  await tx.incidentEvidence.create({
    data: {
      id,
      tenantId: r.tenantId,
      incidentId: r.incidentId,
      kind: 'patrol_track',
      runId: r.runId,
      linkedById: r.byId,
      linkedAt: rowAt(60),
    },
  });
  return id;
}
