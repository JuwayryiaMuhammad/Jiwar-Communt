import { Injectable } from '@nestjs/common';
import type {
  PermitGuest,
  PermitWorker,
  UnitPermit,
  UnitPermitStatus,
} from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';
import { SafetyCore, type UnitLocation } from '../safety/safety-core';
import { PermitCore } from './permit-core';

export const PERMIT_RESOURCE = 'unit_permit';

/** Pending or approved: what may still happen. */
export const LIVE_PERMIT: UnitPermitStatus[] = ['pending', 'approved'];

export const permitNotFound = () =>
  appError.notFound(ErrorCode.PERMIT_NOT_FOUND, 'Permit not found');

/**
 * What a view shows of a permit's status: the stored one, or `ended` for
 * an approved permit whose window has passed (an approved material exit
 * nobody used, too).
 */
export type PermitViewStatus = UnitPermitStatus | 'ended';

export function viewStatus(p: UnitPermit, now: Date): PermitViewStatus {
  return p.status === 'approved' && p.endsAt.getTime() <= now.getTime()
    ? 'ended'
    : p.status;
}

/** Whether it may still change: pending, or approved and not ended. */
export function isOpen(p: UnitPermit, now: Date): boolean {
  return (
    p.status === 'pending' ||
    (p.status === 'approved' && p.endsAt.getTime() > now.getTime())
  );
}

/** A permit with what its views show, read in one transaction. */
export interface PermitRecord {
  permit: UnitPermit;
  location: UnitLocation;
  requester: { id: string; fullName: string | null; status: string };
  /** works: every worker, removed ones too; purged ones carry no name. */
  workers: PermitWorker[];
  /** event: every guest, removed ones too. */
  guests: PermitGuest[];
  /** Presigned reads of the faces and the material photo, by file id. */
  photos: Map<string, PresignedRead>;
  timeZone: string;
  now: Date;
}

/**
 * Reads permits for their views (ADR 0049), and locks their rows. Shared by
 * the resident's side, the management's and the gate's.
 */
@Injectable()
export class PermitRecords {
  constructor(
    private readonly core: PermitCore,
    private readonly safety: SafetyCore,
    private readonly files: FilesService,
  ) {}

  /** The permit's row, locked FOR UPDATE (or FOR SHARE at the gate). */
  async lock(
    tx: TenantTxClient,
    id: string,
    mode: 'update' | 'share' = 'update',
  ): Promise<UnitPermit> {
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM unit_permits WHERE id = ${id}::uuid FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM unit_permits WHERE id = ${id}::uuid FOR SHARE`;
    if (!rows.length) throw permitNotFound();
    return tx.unitPermit.findUniqueOrThrow({ where: { id } });
  }

  async load(tx: TenantTxClient, p: UnitPermit): Promise<PermitRecord> {
    return (await this.loadMany(tx, [p]))[0];
  }

  /**
   * `faces`: presign the workers' faces and the material photo (a detail);
   * a list leaves them out.
   */
  async loadMany(
    tx: TenantTxClient,
    list: UnitPermit[],
    faces = true,
  ): Promise<PermitRecord[]> {
    if (!list.length) return [];
    const ids = list.map((p) => p.id);
    const people = await tx.account.findMany({
      where: { id: { in: [...new Set(list.map((p) => p.requestedById))] } },
      select: { id: true, fullName: true, status: true },
    });
    const locations = await this.safety.locations(tx, [
      ...new Set(list.map((p) => p.unitId)),
    ]);
    const workers = list.some((p) => p.kind === 'works')
      ? await tx.permitWorker.findMany({
          where: { permitId: { in: ids } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const guests = list.some((p) => p.kind === 'event')
      ? await tx.permitGuest.findMany({
          where: { permitId: { in: ids } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const timeZone = await this.core.timeZone(tx);
    const now = await dbNow(tx);
    const photos = new Map<string, PresignedRead>();
    if (faces)
      for (const id of [
        ...workers.map((w) => w.photoFileId),
        ...list.map((p) => p.photoFileId),
      ]) {
        if (!id) continue;
        const read = await this.files.readUrl(tx, id);
        if (read) photos.set(id, read);
      }
    const byId = new Map(people.map((a) => [a.id, a]));
    return list.map((permit) => ({
      permit,
      location: locations.get(permit.unitId) ?? {
        unitId: permit.unitId,
        unitCode: '',
        building: null,
      },
      requester: byId.get(permit.requestedById) ?? {
        id: permit.requestedById,
        fullName: null,
        status: 'erased',
      },
      workers: workers.filter((w) => w.permitId === permit.id),
      guests: guests.filter((g) => g.permitId === permit.id),
      photos,
      timeZone,
      now,
    }));
  }
}
