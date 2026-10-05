import { Injectable } from '@nestjs/common';
import type { ParcelSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { ParcelCore } from './parcel-core';

export type ParcelSettingsView = {
  /** Days a parcel is held before its residents are reminded, once. */
  parcelReminderDays: number;
  /** Days before the managers are told, once, and a guard may return it. */
  parcelManagerDays: number;
};

export const PARCEL_REMINDER_DAYS = { min: 1, max: 30 } as const;
export const PARCEL_MANAGER_DAYS = { min: 2, max: 90 } as const;

const RANGES = {
  parcelReminderDays: PARCEL_REMINDER_DAYS,
  parcelManagerDays: PARCEL_MANAGER_DAYS,
} as const;

function view(s: ParcelSettings): ParcelSettingsView {
  return {
    parcelReminderDays: s.parcelReminderDays,
    parcelManagerDays: s.parcelManagerDays,
  };
}

/**
 * A compound's parcel settings (ADR 0035): one row per compound, created with
 * it. Managed with `parcels.manage`, audited by diff; the reminder always
 * comes before the managers' notice.
 */
@Injectable()
export class ParcelSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly core: ParcelCore,
  ) {}

  async get(): Promise<ParcelSettingsView> {
    return view(
      await this.tenantTx.withTenantTx((tx) => this.core.settings(tx)),
    );
  }

  update(input: Partial<ParcelSettingsView>): Promise<ParcelSettingsView> {
    const fields = Object.entries(RANGES).flatMap(([field, range]) => {
      const value = input[field as keyof ParcelSettingsView];
      return value !== undefined &&
        (!Number.isInteger(value) || value < range.min || value > range.max)
        ? [
            {
              field,
              code: FieldErrorCode.INVALID_NUMBER,
              params: { ...range },
            },
          ]
        : [];
    });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.core.settings(tx);
      const next = {
        parcelReminderDays:
          input.parcelReminderDays ?? before.parcelReminderDays,
        parcelManagerDays: input.parcelManagerDays ?? before.parcelManagerDays,
      };
      // The reminder comes first: the same rule as the table's CHECK.
      if (next.parcelReminderDays >= next.parcelManagerDays)
        throw invalid([
          {
            field: 'parcelReminderDays',
            code: FieldErrorCode.INVALID_NUMBER,
            params: {
              min: PARCEL_REMINDER_DAYS.min,
              max: next.parcelManagerDays - 1,
            },
          },
        ]);
      const after = await tx.parcelSettings.update({
        where: { tenantId: this.ctx.txTenantId },
        data: next,
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'parcel.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'parcel.settings_changed',
          targetId: this.ctx.txTenantId,
          changes,
        });
      return view(after);
    });
  }
}

function invalid(
  fields: {
    field: string;
    code: FieldErrorCode;
    params: Record<string, number>;
  }[],
) {
  return appError.badRequest(
    ErrorCode.VALIDATION_FAILED,
    'Invalid parcel settings',
    { fields },
  );
}
