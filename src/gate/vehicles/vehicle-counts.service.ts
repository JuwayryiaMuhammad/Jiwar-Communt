import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { GateDirection } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';

export const VEHICLE_PASSAGE_RESOURCE = 'gate_vehicle_passage';

/** All a counted passage answers: nothing of the vehicle, the day or the gate. */
export const COUNTED = { counted: true } as const;

/**
 * Resident vehicles through the gate, counted (ADR 0056): a guard on shift
 * taps "in" or "out" for a vehicle the plate lookup found registered
 * (pending or active). The compound's count for the day, the guard's gate
 * and the direction grows by one; nothing else is kept — not the vehicle,
 * nor the time, nor an audit row naming it — so no resident's movements
 * are logged (ADR 0031). The answer names nothing either: the idempotency
 * record keeps only `{ counted: true }`, and its request hash leaves the
 * body out (a compound has few vehicles to try).
 */
@Injectable()
export class VehicleCountsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly settings: TenantSettingsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(VEHICLE_PASSAGE_RESOURCE, () =>
      Promise.resolve(COUNTED),
    );
  }

  count(vehicleId: string, direction: GateDirection): Promise<typeof COUNTED> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      const vehicle = await tx.vehicle.findUnique({
        where: { id: vehicleId },
        select: { status: true },
      });
      if (!vehicle || !['pending', 'active'].includes(vehicle.status))
        throw appError.notFound(
          ErrorCode.VEHICLE_NOT_FOUND,
          'Not a registered vehicle',
        );
      // A random ref: the record names no vehicle.
      await this.idempotency.claim(tx, {
        type: VEHICLE_PASSAGE_RESOURCE,
        id: newId(),
      });
      const { timezone } = await this.settings.inTx(tx, tenantId);
      const day = new Date(
        `${localDate(await dbNow(tx), timezone)}T00:00:00.000Z`,
      );
      await tx.$executeRaw`
        INSERT INTO gate_vehicle_counts (tenant_id, day, gate_id, direction, count)
        VALUES (${tenantId}::uuid, ${day}::date, ${shift.gateId}::uuid,
                ${direction}::gate_direction, 1)
        ON CONFLICT (tenant_id, day, gate_id, direction)
          DO UPDATE SET count = gate_vehicle_counts.count + 1`;
      return COUNTED;
    });
  }
}
