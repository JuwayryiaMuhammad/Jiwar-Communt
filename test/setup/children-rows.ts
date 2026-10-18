import { randomBytes } from 'node:crypto';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { nationalIdFor } from './fixtures';

// Raw rows of the children's tables (ADR 0054), for the schema and
// isolation suites: the shortest valid row of each.

export async function unitRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.unit.create({ data: { id, tenantId, code: `CH-${id}` } });
  return id;
}

/** A minor of the unit (born in 2018), added by `addedById`. */
export async function minorRow(
  tx: TenantTxClient,
  r: { tenantId: string; unitId: string; addedById: string },
): Promise<string> {
  const id = newId();
  const birthDate = new Date('2018-03-04T00:00:00Z');
  await tx.householdMember.create({
    data: {
      id,
      tenantId: r.tenantId,
      unitId: r.unitId,
      relation: 'child',
      isMinor: true,
      fullName: 'Row Child',
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(birthDate),
      nationality: 'EG',
      birthDate,
      status: 'active',
      addedById: r.addedById,
    },
  });
  return id;
}

/** A live control of the minor, with a card. */
export async function controlRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    unitId: string;
    memberId: string;
    turnedOnById: string;
  },
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.childControl.create({
    data: {
      id,
      tenantId: r.tenantId,
      unitId: r.unitId,
      memberId: r.memberId,
      mayLeaveAlone: false,
      notifyPickups: true,
      cardTokenHash: randomBytes(32).toString('hex'),
      cardIssuedAt: now,
      turnedOnById: r.turnedOnById,
      turnedOnAt: now,
    },
  });
  return id;
}

/** A live outside escort of the control, with a pickup code. */
export async function escortRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    controlId: string;
    unitId: string;
    createdById: string;
  },
): Promise<string> {
  const id = newId();
  await tx.childEscort.create({
    data: {
      id,
      tenantId: r.tenantId,
      controlId: r.controlId,
      unitId: r.unitId,
      kind: 'outside',
      fullName: 'Row Escort',
      phone: '+201001234567',
      pickupCodeHash: randomBytes(32).toString('hex'),
      pickupQrHash: randomBytes(32).toString('hex'),
      pickupIssuedAt: new Date(),
      validFrom: new Date('2030-01-01T00:00:00Z'),
      createdById: r.createdById,
    },
  });
  return id;
}
