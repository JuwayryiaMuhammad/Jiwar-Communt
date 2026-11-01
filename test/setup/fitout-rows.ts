import type { FilePurpose } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { dbClock, dbDate, localDay } from './compound-clock';

/** A finalized file nobody owns: attached, as a fit-out's (ADR 0074). */
export async function fitOutFileRow(
  tx: TenantTxClient,
  tenantId: string,
  purpose: FilePurpose = 'fitout_photo',
): Promise<string> {
  const id = newId();
  const now = dbClock();
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

/** A drawing of a works permit, added now. */
export async function drawingRow(
  tx: TenantTxClient,
  input: { tenantId: string; permitId: string; addedBy: string },
): Promise<string> {
  const id = newId();
  await tx.permitDrawing.create({
    data: {
      id,
      tenantId: input.tenantId,
      permitId: input.permitId,
      fileId: await fitOutFileRow(tx, input.tenantId, 'permit_drawing'),
      addedBy: input.addedBy,
      addedAt: dbClock(),
    },
  });
  return id;
}

/** A debris removal scheduled by the staff, its window around now unless told. */
export async function debrisSlotRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    permitId: string;
    scheduledBy: string;
    startsAt?: Date;
    endsAt?: Date;
  },
): Promise<string> {
  const id = newId();
  const now = dbClock();
  const startsAt = input.startsAt ?? new Date(now.getTime() - 10 * 60_000);
  await tx.permitDebrisSlot.create({
    data: {
      id,
      tenantId: input.tenantId,
      permitId: input.permitId,
      day: dbDate(localDay(startsAt)),
      fromMinute: 600,
      toMinute: 660,
      startsAt,
      endsAt: input.endsAt ?? new Date(startsAt.getTime() + 60 * 60_000),
      scheduledBy: input.scheduledBy,
      scheduledSide: 'staff',
      createdAt: now,
    },
  });
  return id;
}

/** An active common area of kind `area`. */
export async function commonAreaRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.commonArea.create({
    data: {
      id,
      tenantId,
      kind: 'area',
      code: `FA-${id.slice(-8)}`,
      nameAr: 'المدخل',
      nameEn: 'Lobby',
    },
  });
  return id;
}

/** A common area before the works, recorded now. */
export async function areaRecordRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    permitId: string;
    commonAreaId: string;
    recordedBy: string;
    phase?: 'before' | 'after';
  },
): Promise<string> {
  const id = newId();
  await tx.permitAreaRecord.create({
    data: {
      id,
      tenantId: input.tenantId,
      permitId: input.permitId,
      commonAreaId: input.commonAreaId,
      phase: input.phase ?? 'before',
      recordedBy: input.recordedBy,
      recordedAt: dbClock(),
    },
  });
  return id;
}

/** A photo of an area record. */
export async function areaPhotoRow(
  tx: TenantTxClient,
  input: { tenantId: string; recordId: string },
): Promise<string> {
  const id = newId();
  await tx.permitAreaPhoto.create({
    data: {
      id,
      tenantId: input.tenantId,
      recordId: input.recordId,
      fileId: await fitOutFileRow(tx, input.tenantId),
      createdAt: dbClock(),
    },
  });
  return id;
}
