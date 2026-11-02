import { Injectable } from '@nestjs/common';
import type { MaintenanceSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';

export type AnalyticsSettings = {
  /** Repairs of a category on one asset (else in one unit) that make a plan suggestion. */
  recurrenceMinTickets: number;
  /** The window they are counted in, days. */
  recurrenceWindowDays: number;
  /** Residents' tickets of a category in one building that make a community case. */
  caseMinTickets: number;
  /** The window they are counted in, days. */
  caseWindowDays: number;
};

export const RECURRENCE_MIN_TICKETS = { min: 2, max: 20 } as const;
export const RECURRENCE_WINDOW_DAYS = { min: 7, max: 366 } as const;
export const CASE_MIN_TICKETS = { min: 2, max: 20 } as const;
export const CASE_WINDOW_DAYS = { min: 1, max: 180 } as const;

const RANGES = {
  recurrenceMinTickets: RECURRENCE_MIN_TICKETS,
  recurrenceWindowDays: RECURRENCE_WINDOW_DAYS,
  caseMinTickets: CASE_MIN_TICKETS,
  caseWindowDays: CASE_WINDOW_DAYS,
} as const;

function view(s: MaintenanceSettings): AnalyticsSettings {
  return {
    recurrenceMinTickets: s.recurrenceMinTickets,
    recurrenceWindowDays: s.recurrenceWindowDays,
    caseMinTickets: s.caseMinTickets,
    caseWindowDays: s.caseWindowDays,
  };
}

/**
 * The maintenance analytics' four numbers (ADR 0081), on the compound's
 * maintenance settings row: when repeat faults make a plan suggestion and
 * when residents' tickets make a community case. `maintenance.manage`;
 * the row locked by its update, the change audited. A new number applies
 * to the next ticket that lands.
 */
@Injectable()
export class AnalyticsSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<AnalyticsSettings> {
    return view(
      await this.tenantTx.withTenantTx((tx) =>
        tx.maintenanceSettings.findUniqueOrThrow({
          where: { tenantId: this.ctx.tenantId },
        }),
      ),
    );
  }

  update(input: Partial<AnalyticsSettings>): Promise<AnalyticsSettings> {
    const fields = Object.entries(RANGES).flatMap(([field, range]) => {
      const value = input[field as keyof AnalyticsSettings];
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
        'Invalid analytics settings',
        { fields },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`
        SELECT tenant_id FROM maintenance_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const old = await tx.maintenanceSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.tenantId },
      });
      const after = await tx.maintenanceSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          recurrenceMinTickets: input.recurrenceMinTickets,
          recurrenceWindowDays: input.recurrenceWindowDays,
          caseMinTickets: input.caseMinTickets,
          caseWindowDays: input.caseWindowDays,
        },
      });
      const changes = diffChanges(
        view(old),
        view(after),
        'maintenance.analytics_settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'maintenance.analytics_settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
