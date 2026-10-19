import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

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
