import { Injectable, type OnModuleInit } from '@nestjs/common';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { ParcelCore } from './parcel-core';

export const PARCEL_REMINDER_SWEEP = 'gate.parcel_reminders';
export const PARCEL_RETENTION_SWEEP = 'gate.parcel_retention';

/** Personal data goes this long after a parcel is handed over or returned. */
export const PARCEL_RETENTION_DAYS = 30;

/** Parcels one run takes per compound and sweep. */
const BATCH = 100;

const DAY = 86_400_000;

/**
 * The parcel sweeps (ADR 0035), a parcel per transaction under its lock, so
 * a hand-over or a rejection in the middle has one winner and a sweep never
 * holds a lock for a batch.
 *
 * - **Reminders:** a held parcel's residents are reminded once at the
 *   compound's `parcelReminderDays`, and the managers told once at
 *   `parcelManagerDays` (`reminded_at`, `held_long_at`, claimed under the
 *   lock). A suspended compound is skipped: nobody is told while it is
 *   locked down.
 * - **Retention:** 30 days after the hand-over or the return, the label's
 *   name, the delegate's name, both photos and the recipient's id are
 *   deleted. The photo files are marked deleted here and the files sweep
 *   removes the objects (ADR 0029). It also runs for a suspended compound,
 *   like the visitor data (ADR 0028). The parcel and its events stay.
 *
 * Both are idempotent and safe on several instances: they claim with a
 * conditional update under the lock.
 */
@Injectable()
export class ParcelSweeps implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly core: ParcelCore,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(PARCEL_REMINDER_SWEEP, (now) => this.remind(now));
    this.sweep.register(PARCEL_RETENTION_SWEEP, (now) => this.retain(now));
  }

  /** Notices sent. */
  remind(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        if (!(await this.active(tx, tenantId))) return [];
        const s = await this.core.settings(tx);
        const parcels = await tx.parcel.findMany({
          where: {
            status: 'held',
            OR: [
              {
                remindedAt: null,
                receivedAt: { lte: ago(now, s.parcelReminderDays) },
              },
              {
                heldLongAt: null,
                receivedAt: { lte: ago(now, s.parcelManagerDays) },
              },
            ],
          },
          select: { id: true },
          orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        return parcels.map((p) => p.id);
      },
      (tx, _tenantId, id) => this.remindOne(tx, id, now),
    );
  }

  /** Parcels cleared. */
  retain(now: Date): Promise<number> {
    const cutoff = ago(now, PARCEL_RETENTION_DAYS);
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const due = await tx.parcel.findMany({
          where: { closedAt: { lte: cutoff }, dataClearedAt: null },
          select: { id: true },
          orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        return due.map((p) => p.id);
      },
      (tx, _tenantId, id) => this.retainOne(tx, id, cutoff, now),
    );
  }

  private async remindOne(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<number> {
    await this.core.lock(tx, id);
    const parcel = await tx.parcel.findUnique({ where: { id } });
    // Read under the lock: a hand-over or a rejection may have won.
    if (parcel?.status !== 'held') return 0;
    const s = await this.core.settings(tx);
    const unitCode = await this.core.unitCodeOf(tx, parcel.unitId);
    const days = Math.floor(
      (now.getTime() - parcel.receivedAt.getTime()) / DAY,
    );
    let sent = 0;

    if (
      parcel.remindedAt === null &&
      parcel.receivedAt <= ago(now, s.parcelReminderDays)
    ) {
      const { count } = await tx.parcel.updateMany({
        where: { id, status: 'held', remindedAt: null },
        data: { remindedAt: now },
      });
      if (count) {
        // A unit nobody can collect for was told to the managers on arrival.
        const residents = await this.core.eligibleOf(tx, parcel.unitId);
        sent += await this.notifier.notify(tx, residents, {
          kind: 'parcel.reminder',
          targetId: id,
          params: {
            carrier: parcel.carrier,
            pieces: parcel.pieces,
            days,
            unitCode,
          },
        });
      }
    }
    if (
      parcel.heldLongAt === null &&
      parcel.receivedAt <= ago(now, s.parcelManagerDays)
    ) {
      const { count } = await tx.parcel.updateMany({
        where: { id, status: 'held', heldLongAt: null },
        data: { heldLongAt: now },
      });
      if (count) {
        const managers = (await this.staff.holding(tx, 'parcels.manage')).map(
          (m) => m.id,
        );
        sent += await this.notifier.notify(tx, managers, {
          kind: 'parcel.held_long',
          targetId: id,
          params: {
            parcelNumber: parcel.number,
            unitCode,
            carrier: parcel.carrier,
            days,
          },
        });
      }
    }
    return sent;
  }

  private async retainOne(
    tx: TenantTxClient,
    id: string,
    cutoff: Date,
    now: Date,
  ): Promise<number> {
    await this.core.lock(tx, id);
    const parcel = await tx.parcel.findUnique({ where: { id } });
    if (
      !parcel ||
      parcel.dataClearedAt !== null ||
      parcel.closedAt === null ||
      parcel.closedAt > cutoff
    )
      return 0;
    // The names, the recipient's id and both photos; the pointers first,
    // then the files (the files sweep removes the objects).
    await tx.parcel.update({
      where: { id },
      data: {
        labelName: null,
        photoFileId: null,
        handoverPhotoFileId: null,
        handedToId: null,
        dataClearedAt: now,
      },
    });
    await tx.parcelCredential.updateMany({
      where: { parcelId: id, delegateName: { not: null } },
      data: { delegateName: null },
    });
    for (const fileId of [parcel.photoFileId, parcel.handoverPhotoFileId])
      if (fileId)
        await this.files.markDeleted(
          tx,
          { id: fileId, purpose: 'parcel_photo' },
          'retention',
        );
    return 1;
  }

  private async active(tx: TenantTxClient, tenantId: string): Promise<boolean> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return tenant?.status === 'active';
  }
}

function ago(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY);
}
