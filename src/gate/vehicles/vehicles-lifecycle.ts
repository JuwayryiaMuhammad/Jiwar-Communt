import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';
import { VisitorParkingService } from '../parking/visitor-parking.service';
import { VehicleCore } from './vehicle-core';

/**
 * What happens to an account's vehicles, visitor parking, appeals and
 * reports when it goes (ADR 0045), in the transaction of what made it go,
 * which holds the account's row:
 *
 * - **It no longer holds `vehicles` on a unit** (it left, its occupancy
 *   ended, it was removed from the household, deactivated, or erased: an
 *   erasure deactivates first): the vehicles it registered there and that
 *   are pending or active are removed by the system (`registrant_left`),
 *   their permits void, and the unit's primary is told, so a car that
 *   stays is registered again. Not when the one who left is the primary,
 *   and not when the unit has none. The rows stay, pointing at the
 *   tombstone once erased; their licence photos go 30 days later.
 * - **It no longer may invite visitors there**: its visitor parking
 *   bookings not yet ended are cancelled by the system (`booker_left`).
 * - **Erased**: what it wrote goes, what the unit's records are stays — a
 *   parking report's note and photo, an appeal's words and photo, the
 *   visitors' names on its bookings, its vehicles' licence photos. The
 *   reports, fines, bookings and vehicles stay, pointing at the tombstone.
 *
 * Locks: vehicle, booking, fine and report rows by id, FOR UPDATE; never a
 * unit's lock or row — a removal only frees.
 */
@Injectable()
export class VehiclesLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityGatePort,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly core: VehicleCore,
    private readonly parking: VisitorParkingService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.registrantLeft(tx, account.id, null);
      await this.bookerLeft(tx, account.id, null);
      return [];
    });
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      const units = await tx.vehicle.findMany({
        where: {
          registeredById: account.id,
          status: { in: ['pending', 'active'] },
        },
        distinct: ['unitId'],
        select: { unitId: true },
      });
      for (const { unitId } of units) {
        const caps = await this.community.placeIn(tx, account.id, unitId);
        if (!caps?.vehicles) await this.registrantLeft(tx, account.id, unitId);
      }
      const booked = await tx.visitorParkingBooking.findMany({
        where: {
          bookedById: account.id,
          status: 'confirmed',
          endsAt: { gt: await dbNow(tx) },
        },
        distinct: ['unitId'],
        select: { unitId: true },
      });
      for (const { unitId } of booked) {
        const caps = await this.community.placeIn(tx, account.id, unitId);
        if (!caps?.visitorsInvite)
          await this.bookerLeft(tx, account.id, unitId);
      }
    });
    this.lifecycle.onErasing(async (tx, account) => {
      // The erasure deactivated the account first; this catches anything a
      // handler order that differs left behind.
      await this.registrantLeft(tx, account.id, null);
      await this.bookerLeft(tx, account.id, null);
      await this.forget(tx, account.id);
      return [];
    });
  }

  /** Its pending and active vehicles (on one unit, or every), removed. */
  private async registrantLeft(
    tx: TenantTxClient,
    accountId: string,
    unitId: string | null,
  ): Promise<void> {
    const rows = unitId
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM vehicles
           WHERE registered_by_account_id = ${accountId}::uuid AND unit_id = ${unitId}::uuid
             AND status IN ('pending', 'active')
           ORDER BY id FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM vehicles
           WHERE registered_by_account_id = ${accountId}::uuid
             AND status IN ('pending', 'active')
           ORDER BY id FOR UPDATE`;
    const now = new Date();
    for (const { id } of rows) {
      const before = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      const vehicle = await tx.vehicle.update({
        where: { id },
        data: {
          status: 'removed',
          stickerNumber: null,
          permitValidUntil: null,
          rejectionReason: null,
          removedAt: now,
          removedById: null,
          removalSide: 'system',
          removalReason: 'registrant_left',
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle.removed',
        targetId: id,
        metadata: {
          unitId: vehicle.unitId,
          side: 'system',
          reasonCode: 'registrant_left',
          previousStatus: before.status,
        },
      });
      const primary = await this.community.primaryOf(tx, vehicle.unitId);
      if (primary && primary !== accountId)
        await this.core.notify(tx, [primary], 'vehicle.registrant_left', id);
    }
  }

  /** Its visitor parking bookings not yet ended (on one unit, or every), cancelled. */
  private async bookerLeft(
    tx: TenantTxClient,
    accountId: string,
    unitId: string | null,
  ): Promise<void> {
    const now = await dbNow(tx);
    const rows = unitId
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM visitor_parking_bookings
           WHERE booked_by_account_id = ${accountId}::uuid AND unit_id = ${unitId}::uuid
             AND status = 'confirmed' AND ends_at > ${now}
           ORDER BY id FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM visitor_parking_bookings
           WHERE booked_by_account_id = ${accountId}::uuid
             AND status = 'confirmed' AND ends_at > ${now}
           ORDER BY id FOR UPDATE`;
    for (const { id } of rows) {
      const booking = await tx.visitorParkingBooking.findUniqueOrThrow({
        where: { id },
      });
      await this.parking.end(tx, booking, {
        side: 'system',
        reason: 'booker_left',
        by: null,
        now,
      });
    }
  }

  /** What the erased account wrote, and its vehicles' licence photos. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const now = new Date();
    const reports = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM parking_reports
       WHERE reporter_account_id = ${accountId}::uuid
         AND (note IS NOT NULL OR photo_file_id IS NOT NULL)
       ORDER BY id FOR UPDATE`;
    for (const { id } of reports) {
      const before = await tx.parkingReport.findUniqueOrThrow({
        where: { id },
      });
      await tx.parkingReport.update({
        where: { id },
        data: {
          note: null,
          noteClearedAt: before.note !== null ? now : before.noteClearedAt,
          photoFileId: null,
        },
      });
      if (before.photoFileId)
        await this.files.markDeleted(
          tx,
          { id: before.photoFileId, purpose: 'parking_photo' },
          'erasure',
        );
    }
    const appeals = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vehicle_fines
       WHERE appealed_by_account_id = ${accountId}::uuid
         AND appeal_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    for (const { id } of appeals) {
      const before = await tx.vehicleFine.findUniqueOrThrow({ where: { id } });
      await tx.vehicleFine.update({
        where: { id },
        data: {
          appealText: null,
          appealPhotoFileId: null,
          appealClearedAt: now,
        },
      });
      if (before.appealPhotoFileId)
        await this.files.markDeleted(
          tx,
          { id: before.appealPhotoFileId, purpose: 'parking_photo' },
          'erasure',
        );
    }
    await tx.$executeRaw`
      UPDATE visitor_parking_bookings
         SET visitor_name = NULL, visitor_name_cleared_at = ${now}
       WHERE booked_by_account_id = ${accountId}::uuid AND visitor_name IS NOT NULL`;
    const vehicles = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vehicles
       WHERE registered_by_account_id = ${accountId}::uuid
         AND licence_photo_file_id IS NOT NULL
       ORDER BY id FOR UPDATE`;
    for (const { id } of vehicles) {
      const before = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      await tx.vehicle.update({
        where: { id },
        data: { licencePhotoFileId: null },
      });
      await this.files.markDeleted(
        tx,
        { id: before.licencePhotoFileId!, purpose: 'vehicle_licence' },
        'erasure',
      );
    }
  }
}
