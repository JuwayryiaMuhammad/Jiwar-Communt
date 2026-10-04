import { Injectable } from '@nestjs/common';
import type { MaintenanceDispatchSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';

/** A compound's dispatch settings, as plain numbers (ADR 0033). */
export interface DispatchSettingsView {
  /** Off for every compound until the manager turns it on. */
  autoDispatchEnabled: boolean;
  /** What a ticket in each open status weighs on its technician. */
  weightAssigned: number;
  weightInProgress: number;
  weightOnHold: number;
  /** What each priority multiplies that weight by. */
  multiplierNormal: number;
  multiplierUrgent: number;
  multiplierEmergency: number;
}

export const WEIGHT = { min: 0, max: 100 } as const;
export const MULTIPLIER = { min: 0.1, max: 100 } as const;
/** The columns are NUMERIC(5,2). */
export const DECIMAL_PLACES = 2;

const RANGES = {
  weightAssigned: WEIGHT,
  weightInProgress: WEIGHT,
  weightOnHold: WEIGHT,
  multiplierNormal: MULTIPLIER,
  multiplierUrgent: MULTIPLIER,
  multiplierEmergency: MULTIPLIER,
} as const;

function view(s: MaintenanceDispatchSettings): DispatchSettingsView {
  return {
    autoDispatchEnabled: s.autoDispatchEnabled,
    weightAssigned: s.weightAssigned.toNumber(),
    weightInProgress: s.weightInProgress.toNumber(),
    weightOnHold: s.weightOnHold.toNumber(),
    multiplierNormal: s.multiplierNormal.toNumber(),
    multiplierUrgent: s.multiplierUrgent.toNumber(),
    multiplierEmergency: s.multiplierEmergency.toNumber(),
  };
}

/** At most two decimals, without trusting floating-point multiplication. */
export function hasAtMostTwoDecimals(value: number): boolean {
  return (
    Number.isFinite(value) && Number(value.toFixed(DECIMAL_PLACES)) === value
  );
}

/**
 * A compound's dispatch settings (ADR 0033): whether tickets are assigned
 * automatically, and the weights that make a technician's workload. One
 * row per compound, created with it. Managed with `maintenance.manage`;
 * the engine reads it inside its own transactions with `inTx`.
 */
@Injectable()
export class DispatchSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** The compound's row, whichever transaction (a request's or a sweep's). */
  async inTx(tx: TenantTxClient): Promise<DispatchSettingsView> {
    return view(
      await tx.maintenanceDispatchSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.txTenantId },
      }),
    );
  }

  get(): Promise<DispatchSettingsView> {
    return this.tenantTx.withTenantTx((tx) => this.inTx(tx));
  }

  update(input: Partial<DispatchSettingsView>): Promise<DispatchSettingsView> {
    const fields = Object.entries(RANGES).flatMap(([field, range]) => {
      const value = input[field as keyof typeof RANGES];
      return value !== undefined &&
        (!hasAtMostTwoDecimals(value) || value < range.min || value > range.max)
        ? [
            {
              field,
              code: FieldErrorCode.INVALID_NUMBER,
              params: { ...range },
            },
          ]
        : [];
    });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid dispatch settings',
        { fields },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.inTx(tx);
      const after = view(
        await tx.maintenanceDispatchSettings.update({
          where: { tenantId: this.ctx.tenantId },
          data: {
            autoDispatchEnabled: input.autoDispatchEnabled,
            weightAssigned: input.weightAssigned,
            weightInProgress: input.weightInProgress,
            weightOnHold: input.weightOnHold,
            multiplierNormal: input.multiplierNormal,
            multiplierUrgent: input.multiplierUrgent,
            multiplierEmergency: input.multiplierEmergency,
          },
        }),
      );
      const changes = diffChanges(
        { ...before },
        { ...after },
        'maintenance.dispatch_settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'maintenance.dispatch_settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return after;
    });
  }
}
