import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// ============================================================================
// Permit rows written straight into the tables (ADR 0049), for the suites
// that test the database itself: the schema and isolation suites. Each
// returns the row's id.
// ============================================================================

let next = 1;
/** A number nobody else in the run takes (the unique per compound and kind). */
const number = () => 900_000 + next++ + Math.floor(Math.random() * 90_000);

// eslint-disable-next-line no-restricted-syntax -- any instant for a raw row: no server code reads its compound day
const DAY = 86_400_000;
/** A 64-character hex string, as a keyed hash would be. */
export const HASH = 'a'.repeat(64);

export async function permitCounterRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  await tx.permitCounter.upsert({
    where: { tenantId_kind: { tenantId, kind: 'works' } },
    create: { tenantId, kind: 'works', lastNumber: 1 },
    update: {},
  });
  return tenantId;
}

/** A finalized image that nobody owns: attached, as a worker's face. */
export async function permitFileRow(
  tx: TenantTxClient,
  tenantId: string,
  purpose: 'contractor_photo' | 'permit_photo' = 'contractor_photo',
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose,
      contentType: 'image/png',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}

/** What each kind carries at the least, pending. */
export function permitShape(
  kind: 'works' | 'move' | 'material_exit' | 'event',
): Partial<Prisma.UnitPermitUncheckedCreateInput> {
  switch (kind) {
    case 'works':
      return {
        workType: 'renovation',
        dailyFrom: 540,
        dailyTo: 1020,
        contractorCompany: 'Row Contractors',
        description: 'Row words',
      };
    case 'move':
      return {
        truckPlate: 'ROW 123',
        itemsDescription: 'Row items',
        moveDirection: 'in',
      };
    case 'material_exit':
      return { items: [{ name: 'Row item', quantity: 1 }] };
    case 'event':
      return { guestLimit: 20 };
  }
}

export async function permitRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    unitId: string;
    requestedById: string;
    kind?: 'works' | 'move' | 'material_exit' | 'event';
    data?: Partial<Prisma.UnitPermitUncheckedCreateInput>;
  },
): Promise<string> {
  const id = newId();
  const kind = input.kind ?? 'works';
  const now = Date.now();
  await tx.unitPermit.create({
    data: {
      id,
      tenantId: input.tenantId,
      number: number(),
      kind,
      unitId: input.unitId,
      requestedById: input.requestedById,
      startsAt: new Date(now + DAY),
      // eslint-disable-next-line test-clock/day-multiple -- any instant for a raw row: no server code reads its compound day
      endsAt: new Date(now + 3 * DAY),
      ...permitShape(kind),
      ...input.data,
    },
  });
  return id;
}

export async function permitWorkerRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    permitId: string;
    addedById: string;
    photoFileId: string;
  },
): Promise<string> {
  const id = newId();
  await tx.permitWorker.create({
    data: {
      id,
      tenantId: input.tenantId,
      permitId: input.permitId,
      fullName: 'Row Worker',
      photoFileId: input.photoFileId,
      idType: 'national_id',
      idLast4Hash: HASH,
      addedById: input.addedById,
    },
  });
  return id;
}

export async function permitGuestRow(
  tx: TenantTxClient,
  input: { tenantId: string; permitId: string; addedById: string },
): Promise<string> {
  const id = newId();
  await tx.permitGuest.create({
    data: {
      id,
      tenantId: input.tenantId,
      permitId: input.permitId,
      fullName: 'Row Guest',
      vehiclePlate: 'GST 1',
      addedById: input.addedById,
    },
  });
  return id;
}
