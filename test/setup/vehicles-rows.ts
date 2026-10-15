import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// ============================================================================
// Vehicles and parking rows written straight into the tables (ADR 0045),
// for the suites that test the database itself: the schema and isolation
// suites. Each returns the row's id.
// ============================================================================

let next = 1;
/** A number nobody else in the run takes (the unique per compound). */
const number = () => 900_000 + next++ + Math.floor(Math.random() * 90_000);

export async function vehicleRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    unitId: string;
    registeredById: string;
    plate?: string;
  },
): Promise<string> {
  const id = newId();
  await tx.vehicle.create({
    data: {
      id,
      tenantId: input.tenantId,
      number: number(),
      unitId: input.unitId,
      registeredById: input.registeredById,
      plate: input.plate ?? `ROW ${next}`,
      makeAndModel: 'Row car',
      color: 'Grey',
      type: 'car',
    },
  });
  return id;
}

export async function stickerRow(
  tx: TenantTxClient,
  input: { tenantId: string; vehicleId: string; issuedById: string },
): Promise<string> {
  const id = newId();
  await tx.vehicleSticker.create({
    data: {
      id,
      tenantId: input.tenantId,
      vehicleId: input.vehicleId,
      stickerNumber: `ROW-${id.slice(-12).toUpperCase()}`,
      issuedById: input.issuedById,
    },
  });
  return id;
}

export async function expiryReminderRow(
  tx: TenantTxClient,
  input: { tenantId: string; vehicleId: string },
): Promise<string> {
  const id = newId();
  await tx.vehicleExpiryReminder.create({
    data: {
      id,
      tenantId: input.tenantId,
      vehicleId: input.vehicleId,
      validUntil: new Date(Date.UTC(2030, 0, 1 + (next++ % 300))),
    },
  });
  return id;
}

export async function slotRow(
  tx: TenantTxClient,
  input: { tenantId: string; unitId: string },
): Promise<string> {
  const id = newId();
  await tx.unitParkingSlot.create({
    data: {
      id,
      tenantId: input.tenantId,
      unitId: input.unitId,
      code: `R-${id.slice(-10).toUpperCase()}`,
      place: 'Row place',
    },
  });
  return id;
}

export async function areaRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.visitorParkingArea.create({
    data: { id, tenantId, name: `Row area ${id.slice(-8)}`, capacity: 5 },
  });
  return id;
}

export async function parkingBookingRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    unitId: string;
    areaId: string;
    bookedById: string;
  },
): Promise<string> {
  const id = newId();
  const startsAt = new Date(Date.now() + 3_600_000);
  await tx.visitorParkingBooking.create({
    data: {
      id,
      tenantId: input.tenantId,
      number: number(),
      unitId: input.unitId,
      areaId: input.areaId,
      visitorName: 'Row visitor',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      bookedById: input.bookedById,
    },
  });
  return id;
}

export async function fineRow(
  tx: TenantTxClient,
  input: { tenantId: string; unitId: string; issuedById: string },
): Promise<string> {
  const id = newId();
  await tx.vehicleFine.create({
    data: {
      id,
      tenantId: input.tenantId,
      number: number(),
      unitId: input.unitId,
      plate: 'ROW 1',
      reason: 'blocking',
      amount: new Prisma.Decimal('100'),
      occurredOn: new Date('2026-10-15T00:00:00.000Z'),
      issuedById: input.issuedById,
    },
  });
  return id;
}

export async function finePaymentRow(
  tx: TenantTxClient,
  input: { tenantId: string; fineId: string; recordedById: string },
): Promise<string> {
  const id = newId();
  await tx.vehicleFinePayment.create({
    data: {
      id,
      tenantId: input.tenantId,
      fineId: input.fineId,
      kind: 'payment',
      amount: new Prisma.Decimal('100'),
      currency: 'EGP',
      receiptNumber: `ROW-${id.slice(-12)}`,
      paidOn: new Date('2026-10-15T00:00:00.000Z'),
      recordedById: input.recordedById,
    },
  });
  return id;
}

export async function reportRow(
  tx: TenantTxClient,
  input: { tenantId: string; reporterId: string },
): Promise<string> {
  const id = newId();
  await tx.parkingReport.create({
    data: {
      id,
      tenantId: input.tenantId,
      number: number(),
      reporterId: input.reporterId,
      plate: 'ROW 2',
      location: 'Row place',
      note: 'Row note',
    },
  });
  return id;
}
