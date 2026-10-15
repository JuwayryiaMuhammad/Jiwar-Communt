import { Injectable } from '@nestjs/common';
import type { VehicleSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { TenantTx } from '../../core/database/tenant-tx.service';
import type { VehicleSettingName } from './defaults';

export type VehicleSettingsView = Record<VehicleSettingName, number>;

function view(s: VehicleSettings): VehicleSettingsView {
  return {
    maxVehiclesPerUnit: s.maxVehiclesPerUnit,
    visitorParkingMaxHours: s.visitorParkingMaxHours,
    maxActiveVisitorParkingBookings: s.maxActiveVisitorParkingBookings,
  };
}

/**
 * A compound's vehicle and parking settings (ADR 0045): one row per
 * compound, created with it, managed with `vehicles.manage`. A write that
 * counts against a limit reads the row FOR SHARE, so a change waits for it;
 * a lower limit leaves what a unit holds already.
 */
@Injectable()
export class VehicleSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<VehicleSettingsView> {
    return view(
      await this.tenantTx.withTenantTx((tx) =>
        tx.vehicleSettings.findUniqueOrThrow({
          where: { tenantId: this.ctx.tenantId },
        }),
      ),
    );
  }

  update(input: Partial<VehicleSettingsView>): Promise<VehicleSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`
        SELECT tenant_id FROM vehicle_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await tx.vehicleSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.tenantId },
      });
      const after = await tx.vehicleSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          maxVehiclesPerUnit: input.maxVehiclesPerUnit,
          visitorParkingMaxHours: input.visitorParkingMaxHours,
          maxActiveVisitorParkingBookings:
            input.maxActiveVisitorParkingBookings,
        },
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'vehicle.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'vehicle.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
