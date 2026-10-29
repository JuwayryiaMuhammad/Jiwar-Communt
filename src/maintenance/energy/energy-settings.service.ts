import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';

/** A spike is the period's daily use above the mean times this (ADR 0066). */
export const ANOMALY_FACTOR = { min: 1.2, max: 10 } as const;
/** How many earlier periods make the mean. */
export const ANOMALY_PERIODS = { min: 3, max: 24 } as const;

export interface EnergySettings {
  anomalyFactor: Prisma.Decimal;
  anomalyPeriods: number;
}

// A type, not an interface: the audit's diff takes it as a record.
export type EnergySettingsView = {
  anomalyFactor: string;
  anomalyPeriods: number;
};

const view = (s: EnergySettings): EnergySettingsView => ({
  anomalyFactor: s.anomalyFactor.toFixed(2),
  anomalyPeriods: s.anomalyPeriods,
});

/**
 * The compound's spike rule (ADR 0066), kept on its maintenance settings'
 * row (one per compound, made with it) and changed with `energy.manage`.
 */
@Injectable()
export class EnergySettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  inTx(tx: TenantTxClient): Promise<EnergySettings> {
    return tx.maintenanceSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.tenantId },
      select: { anomalyFactor: true, anomalyPeriods: true },
    });
  }

  async get(): Promise<EnergySettingsView> {
    return view(await this.tenantTx.withTenantTx((tx) => this.inTx(tx)));
  }

  update(input: {
    anomalyFactor?: string;
    anomalyPeriods?: number;
  }): Promise<EnergySettingsView> {
    const fields: FieldError[] = [];
    if (
      input.anomalyFactor !== undefined &&
      (Number(input.anomalyFactor) < ANOMALY_FACTOR.min ||
        Number(input.anomalyFactor) > ANOMALY_FACTOR.max)
    )
      fields.push({
        field: 'anomalyFactor',
        code: FieldErrorCode.INVALID_NUMBER,
        params: { ...ANOMALY_FACTOR },
      });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid energy settings',
        { fields },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.inTx(tx);
      const after = await tx.maintenanceSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          anomalyFactor:
            input.anomalyFactor === undefined
              ? undefined
              : new Prisma.Decimal(input.anomalyFactor),
          anomalyPeriods: input.anomalyPeriods,
        },
        select: { anomalyFactor: true, anomalyPeriods: true },
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'energy.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'energy.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
