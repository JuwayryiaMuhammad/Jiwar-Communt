import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// Raw rows of the guard shifts and tasks tables (ADR 0050), for the schema
// and isolation suites: the shortest valid row of each.

const HOUR = 3_600_000;

export async function gateRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.gate.create({
    data: { id, tenantId, name: `Gate ${id}`, kind: 'mixed' },
  });
  return id;
}

export async function templateRow(
  tx: TenantTxClient,
  r: { tenantId: string; guardId: string; gateId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.guardRosterTemplate.create({
    data: {
      id,
      tenantId: r.tenantId,
      guardAccountId: r.guardId,
      gateId: r.gateId,
      schedule: { days: [1], windows: [{ from: '06:00', to: '14:00' }] },
      effectiveFrom: new Date('2030-01-01T00:00:00Z'),
      createdById: r.createdById,
    },
  });
  return id;
}

/** A single slot, `inHours` from now, an hour long. */
export async function slotRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    guardId: string;
    gateId: string;
    createdById: string;
    inHours?: number;
  },
): Promise<string> {
  const id = newId();
  const startsAt = new Date(Date.now() + (r.inHours ?? 24) * HOUR);
  await tx.guardRosterSlot.create({
    data: {
      id,
      tenantId: r.tenantId,
      guardAccountId: r.guardId,
      gateId: r.gateId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR),
      createdById: r.createdById,
    },
  });
  return id;
}

/** An ended shift at a gate, an hour long, ending now. */
export async function shiftRow(
  tx: TenantTxClient,
  r: { tenantId: string; guardId: string; gateId: string },
): Promise<string> {
  const id = newId();
  await tx.guardShift.create({
    data: {
      id,
      tenantId: r.tenantId,
      guardAccountId: r.guardId,
      gateId: r.gateId,
      startedAt: new Date(Date.now() - HOUR),
      endedAt: new Date(),
      endReason: 'guard',
    },
  });
  return id;
}

export async function handoverItemRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.guardHandoverItem.create({
    data: { id, tenantId, label: `Item ${id}` },
  });
  return id;
}

export async function handoverRow(
  tx: TenantTxClient,
  r: { tenantId: string; shiftId: string; guardId: string; gateId: string },
): Promise<string> {
  const id = newId();
  await tx.guardHandover.create({
    data: {
      id,
      tenantId: r.tenantId,
      shiftId: r.shiftId,
      guardAccountId: r.guardId,
      gateId: r.gateId,
      kind: 'guard',
      notes: 'Row notes',
    },
  });
  return id;
}

/** A ready, attached file of a guard duty purpose. */
export async function dutyFileRow(
  tx: TenantTxClient,
  tenantId: string,
  purpose: 'guard_task_photo' | 'found_item_photo' = 'guard_task_photo',
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

/** A custom task for a gate, open. */
export async function taskRow(
  tx: TenantTxClient,
  r: { tenantId: string; gateId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.guardTask.create({
    data: {
      id,
      tenantId: r.tenantId,
      kind: 'custom',
      title: 'Row task',
      gateId: r.gateId,
      createdById: r.createdById,
    },
  });
  return id;
}

export async function taskPhotoRow(
  tx: TenantTxClient,
  r: { tenantId: string; taskId: string; fileId: string; uploadedById: string },
): Promise<string> {
  const id = newId();
  await tx.guardTaskPhoto.create({
    data: {
      id,
      tenantId: r.tenantId,
      taskId: r.taskId,
      fileId: r.fileId,
      uploadedById: r.uploadedById,
    },
  });
  return id;
}
