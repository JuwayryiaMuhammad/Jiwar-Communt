import { Injectable } from '@nestjs/common';
import type { MaintenanceSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';

export type MaintenanceSettingsView = {
  /** A completed ticket nobody confirms closes itself after this long. */
  autoCloseHours: number;
  /** How long after closing the reporter may reopen. */
  reopenDays: number;
  /** Report photos per ticket. */
  maxReportPhotos: number;
  /**
   * Visiting hours (ADR 0038), in minutes after local midnight: the slots
   * residents may pick when a visit moves.
   */
  visitHoursStart: number;
  visitHoursEnd: number;
  visitSlotMinutes: number;
};

export const AUTO_CLOSE_HOURS = { min: 1, max: 720 } as const;
export const REOPEN_DAYS = { min: 1, max: 90 } as const;
export const MAX_REPORT_PHOTOS = { min: 1, max: 10 } as const;
export const VISIT_HOURS_START = { min: 0, max: 1439 } as const;
export const VISIT_HOURS_END = { min: 1, max: 1440 } as const;
/** Never longer than a visit (4 h, ADR 0034). */
export const VISIT_SLOT_MINUTES = { min: 15, max: 240 } as const;

const RANGES = {
  autoCloseHours: AUTO_CLOSE_HOURS,
  reopenDays: REOPEN_DAYS,
  maxReportPhotos: MAX_REPORT_PHOTOS,
  visitHoursStart: VISIT_HOURS_START,
  visitHoursEnd: VISIT_HOURS_END,
  visitSlotMinutes: VISIT_SLOT_MINUTES,
} as const;

function view(s: MaintenanceSettings): MaintenanceSettingsView {
  return {
    autoCloseHours: s.autoCloseHours,
    reopenDays: s.reopenDays,
    maxReportPhotos: s.maxReportPhotos,
    visitHoursStart: s.visitHoursStart,
    visitHoursEnd: s.visitHoursEnd,
    visitSlotMinutes: s.visitSlotMinutes,
  };
}

/**
 * A compound's maintenance settings (ADR 0032): one row per compound,
 * created with it. Managed with `maintenance.manage`; the domain reads it
 * inside its own transactions with `inTx`.
 */
@Injectable()
export class MaintenanceSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  inTx(tx: TenantTxClient): Promise<MaintenanceSettings> {
    return tx.maintenanceSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.tenantId },
    });
  }

  async get(): Promise<MaintenanceSettingsView> {
    return view(await this.tenantTx.withTenantTx((tx) => this.inTx(tx)));
  }

  update(
    input: Partial<MaintenanceSettingsView>,
  ): Promise<MaintenanceSettingsView> {
    const fields = Object.entries(RANGES).flatMap(([field, range]) => {
      const value = input[field as keyof MaintenanceSettingsView];
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
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid maintenance settings',
        { fields },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.inTx(tx);
      // The hours hold at least one slot, whatever part of them changes
      // (the CHECK says the same).
      const start = input.visitHoursStart ?? before.visitHoursStart;
      const end = input.visitHoursEnd ?? before.visitHoursEnd;
      const slot = input.visitSlotMinutes ?? before.visitSlotMinutes;
      if (end - start < slot)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid maintenance settings',
          {
            fields: [
              {
                field: 'visitHoursEnd',
                code: FieldErrorCode.VISIT_HOURS_TOO_SHORT,
                params: { min: start + slot },
              },
            ],
          },
        );
      const after = await tx.maintenanceSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          autoCloseHours: input.autoCloseHours,
          reopenDays: input.reopenDays,
          maxReportPhotos: input.maxReportPhotos,
          visitHoursStart: input.visitHoursStart,
          visitHoursEnd: input.visitHoursEnd,
          visitSlotMinutes: input.visitSlotMinutes,
        },
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'maintenance.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'maintenance.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
