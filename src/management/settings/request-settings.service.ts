import { Injectable } from '@nestjs/common';
import type { ManagementRequestSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';

export type RequestSettingsView = {
  /** An answered request its author does not reply to closes after this long. */
  autoCloseDays: number;
  /** The length of an appointment slot. */
  appointmentSlotMinutes: number;
  /** Appointments one slot takes. */
  appointmentSlotCapacity: number;
};

export const AUTO_CLOSE_DAYS = { min: 1, max: 90 } as const;
/** Never longer than an appointment's window (4 h, the CHECK). */
export const APPOINTMENT_SLOT_MINUTES = { min: 10, max: 240 } as const;
export const APPOINTMENT_SLOT_CAPACITY = { min: 1, max: 50 } as const;

const RANGES = {
  autoCloseDays: AUTO_CLOSE_DAYS,
  appointmentSlotMinutes: APPOINTMENT_SLOT_MINUTES,
  appointmentSlotCapacity: APPOINTMENT_SLOT_CAPACITY,
} as const;

function view(s: ManagementRequestSettings): RequestSettingsView {
  return {
    autoCloseDays: s.autoCloseDays,
    appointmentSlotMinutes: s.appointmentSlotMinutes,
    appointmentSlotCapacity: s.appointmentSlotCapacity,
  };
}

/**
 * A compound's management request settings (ADR 0039): one row per
 * compound, created with it. Managed with `requests.manage`; the domain
 * reads it inside its own transactions with `inTx`.
 */
@Injectable()
export class RequestSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Also inside a sweep's transaction, where there is no request. */
  inTx(tx: TenantTxClient): Promise<ManagementRequestSettings> {
    return tx.managementRequestSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  /**
   * The row under its lock: what changes the office hours or the slots
   * waits here, so two changes never interleave.
   */
  async lock(tx: TenantTxClient): Promise<ManagementRequestSettings> {
    await tx.$queryRaw`
      SELECT tenant_id FROM management_request_settings
       WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR UPDATE`;
    return this.inTx(tx);
  }

  async get(): Promise<RequestSettingsView> {
    return view(await this.tenantTx.withTenantTx((tx) => this.inTx(tx)));
  }

  /**
   * A new slot length or capacity changes the slots offered from now on;
   * appointments already booked keep their window.
   */
  update(input: Partial<RequestSettingsView>): Promise<RequestSettingsView> {
    const fields = Object.entries(RANGES).flatMap(([field, range]) => {
      const value = input[field as keyof RequestSettingsView];
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
        'Invalid management request settings',
        { fields },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx);
      const after = await tx.managementRequestSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          autoCloseDays: input.autoCloseDays,
          appointmentSlotMinutes: input.appointmentSlotMinutes,
          appointmentSlotCapacity: input.appointmentSlotCapacity,
        },
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'management.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'management.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
