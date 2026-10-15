import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { addDays, localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { VehicleCore } from './vehicle-core';
import {
  asDate,
  dayOf,
  EXPIRING_DAYS,
  LICENCE_PHOTO_RETENTION_DAYS,
} from './vehicle-rules';

export const PERMIT_EXPIRING_SWEEP = 'vehicles.permit_expiring';
export const LICENCE_PHOTO_SWEEP = 'vehicles.licence_photos';

/** Vehicles one run takes per compound and sweep. */
const BATCH = 200;
const DAY = 86_400_000;

/**
 * The vehicle sweeps (ADR 0045), one vehicle per transaction.
 *
 * - **Permit expiring:** an active permit whose last day is within 30
 *   days tells its registrant, once per last day (a unique row claimed
 *   with ON CONFLICT DO NOTHING), so a renewal arms it again. The
 *   registrant while they still hold `vehicles` on the unit, otherwise the
 *   unit's primary. A suspended compound waits.
 * - **Licence photos:** 30 days after a removal, the vehicle's licence
 *   photo is deleted: the pointer first, then the file is marked deleted
 *   and the files sweep removes the object (ADR 0029). Runs for a
 *   suspended compound too, like every retention.
 *
 * Both are idempotent and safe on several instances.
 */
@Injectable()
export class VehicleSweeps implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly core: VehicleCore,
    private readonly community: CommunityGatePort,
    private readonly tenantSettings: TenantSettingsService,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(PERMIT_EXPIRING_SWEEP, (now) => this.remind(now));
    this.sweep.register(LICENCE_PHOTO_SWEEP, (now) => this.retain(now));
  }

  /** Notices sent. */
  remind(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        if (!(await this.active(tx, tenantId))) return [];
        const { timezone } = await this.tenantSettings.inTx(tx, tenantId);
        const today = localDate(now, timezone);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT v.id FROM vehicles v
           WHERE v.status = 'active'
             AND v.permit_valid_until >= ${asDate(today)}::date
             AND v.permit_valid_until <= ${asDate(addDays(today, EXPIRING_DAYS))}::date
             AND NOT EXISTS (
               SELECT 1 FROM vehicle_expiry_reminders r
                WHERE r.vehicle_id = v.id AND r.valid_until = v.permit_valid_until)
           ORDER BY v.permit_valid_until, v.id
           LIMIT ${BATCH}`;
        return rows.map((r) => r.id);
      },
      async (tx, tenantId, id) => {
        await tx.$queryRaw`SELECT id FROM vehicles WHERE id = ${id}::uuid FOR UPDATE`;
        const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id } });
        const validUntil = dayOf(vehicle.permitValidUntil);
        if (vehicle.status !== 'active' || !validUntil) return 0;
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO vehicle_expiry_reminders (id, tenant_id, vehicle_id, valid_until)
          VALUES (${newId()}::uuid, ${tenantId}::uuid, ${id}::uuid, ${asDate(validUntil)}::date)
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!inserted.length) return 0;
        const caps = await this.community.placeIn(
          tx,
          vehicle.registeredById,
          vehicle.unitId,
        );
        const to = caps?.vehicles
          ? vehicle.registeredById
          : await this.community.primaryOf(tx, vehicle.unitId);
        return this.core.notify(tx, [to], 'vehicle.permit_expiring', id);
      },
    );
  }

  /** Photos deleted. */
  retain(now: Date): Promise<number> {
    const due = new Date(now.getTime() - LICENCE_PHOTO_RETENTION_DAYS * DAY);
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const rows = await tx.vehicle.findMany({
          where: {
            removedAt: { lte: due },
            licencePhotoFileId: { not: null },
          },
          select: { id: true },
          orderBy: [{ removedAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        return rows.map((r) => r.id);
      },
      async (tx, _tenantId, id) => {
        await tx.$queryRaw`SELECT id FROM vehicles WHERE id = ${id}::uuid FOR UPDATE`;
        const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id } });
        const fileId = vehicle.licencePhotoFileId;
        if (!fileId || !vehicle.removedAt || vehicle.removedAt > due) return 0;
        await tx.vehicle.update({
          where: { id },
          data: { licencePhotoFileId: null },
        });
        await this.files.markDeleted(
          tx,
          { id: fileId, purpose: 'vehicle_licence' },
          'retention',
        );
        return 1;
      },
    );
  }

  private async active(tx: TenantTxClient, tenantId: string): Promise<boolean> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return tenant?.status === 'active';
  }
}
