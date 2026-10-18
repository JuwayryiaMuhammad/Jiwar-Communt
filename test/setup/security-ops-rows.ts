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

/** A live stop of an approved works permit's work. */
export async function workStopRow(
  tx: TenantTxClient,
  r: { tenantId: string; permitId: string; stoppedById: string },
): Promise<string> {
  const id = newId();
  await tx.permitWorkStop.create({
    data: {
      id,
      tenantId: r.tenantId,
      permitId: r.permitId,
      stoppedById: r.stoppedById,
      reasonCode: 'safety_hazard',
      stoppedAt: new Date(),
    },
  });
  return id;
}

let incidents = 0;

/** An open incident at a unit, reported from the office. */
export async function incidentRow(
  tx: TenantTxClient,
  r: { tenantId: string; unitId: string; reportedById: string },
): Promise<string> {
  const id = newId();
  await tx.incident.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: 900_000 + ++incidents,
      type: 'hazard',
      severity: 'low',
      unitId: r.unitId,
      occurredAt: new Date(),
      description: 'Row words',
      reportedById: r.reportedById,
    },
  });
  return id;
}

export async function incidentPhotoRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    incidentId: string;
    fileId: string;
    uploadedById: string;
  },
): Promise<string> {
  const id = newId();
  await tx.incidentPhoto.create({ data: { id, ...r } });
  return id;
}

export async function incidentNoteRow(
  tx: TenantTxClient,
  r: { tenantId: string; incidentId: string; authorId: string },
): Promise<string> {
  const id = newId();
  await tx.incidentNote.create({ data: { id, ...r, body: 'Row note' } });
  return id;
}

/** An acknowledgement: its incident id (the key with the role). */
export async function incidentAckRow(
  tx: TenantTxClient,
  r: { tenantId: string; incidentId: string; accountId: string },
): Promise<string> {
  await tx.incidentAcknowledgement.create({ data: { ...r, role: 'author' } });
  return r.incidentId;
}

let violations = 0;

/** An open noise warning to a unit, from the office. */
export async function violationRow(
  tx: TenantTxClient,
  r: { tenantId: string; unitId: string; issuedById: string; amount?: string },
): Promise<string> {
  const id = newId();
  await tx.unitViolation.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: 900_000 + ++violations,
      kind: 'noise',
      unitId: r.unitId,
      occurredOn: new Date(),
      issuedById: r.issuedById,
      ...(r.amount ? { amount: r.amount, currency: 'EGP' } : {}),
    },
  });
  return id;
}

/** A payment of a violation's whole amount. */
export async function violationPaymentRow(
  tx: TenantTxClient,
  r: { tenantId: string; violationId: string; recordedById: string },
): Promise<string> {
  const id = newId();
  await tx.unitViolationPayment.create({
    data: {
      id,
      tenantId: r.tenantId,
      violationId: r.violationId,
      kind: 'payment',
      amount: '100',
      currency: 'EGP',
      receiptNumber: `ROW-${id.slice(-12)}`,
      paidOn: new Date(),
      recordedById: r.recordedById,
    },
  });
  return id;
}
