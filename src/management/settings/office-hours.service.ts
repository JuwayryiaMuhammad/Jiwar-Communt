import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import type { OfficeWindow } from './defaults';
import {
  officeHoursProblems,
  officeStatus,
  sortedWindows,
  windowCode,
} from './office-hours-rules';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';

export interface ResidentOfficeHours {
  timeZone: string;
  windows: OfficeWindow[];
  openNow: boolean;
  closesAt: Date | null;
  nextOpensAt: Date | null;
}
import { RequestSettingsService } from './request-settings.service';

const plain = (w: OfficeWindow): OfficeWindow => ({
  weekday: w.weekday,
  startMinute: w.startMinute,
  endMinute: w.endMinute,
});

/**
 * A compound's office hours (ADR 0039): weekly windows in its own time
 * zone, from which the appointment slots are cut. Managed with
 * `requests.manage`. The set is replaced as a whole, under the settings
 * row's lock, so two managers saving at once leave one of the two sets and
 * never a mix.
 */
@Injectable()
export class OfficeHoursService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly settings: RequestSettingsService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  async inTx(tx: TenantTxClient): Promise<OfficeWindow[]> {
    const rows = await tx.managementOfficeHours.findMany({
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
    return rows.map(plain);
  }

  get(): Promise<OfficeWindow[]> {
    return this.tenantTx.withTenantTx((tx) => this.inTx(tx));
  }

  /**
   * The office hours as residents read them (ADR 0058): the windows, the
   * compound's time zone, and whether the office is open now and until
   * when, or when it opens next, by the database's clock.
   */
  forResidents(): Promise<ResidentOfficeHours> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const windows = await this.inTx(tx);
      const { timezone } = await this.tenantSettings.inTx(
        tx,
        this.ctx.tenantId,
      );
      return {
        timeZone: timezone,
        windows,
        ...officeStatus(windows, await dbNow(tx), timezone),
      };
    });
  }

  /**
   * An empty set closes the office: no slot is offered. Appointments already
   * booked keep their window whatever the hours become.
   */
  replace(input: readonly OfficeWindow[]): Promise<OfficeWindow[]> {
    const fields: FieldError[] = officeHoursProblems(input).map((p) =>
      p.problem === 'overlaps'
        ? {
            field: `windows.${p.index}.startMinute`,
            code: FieldErrorCode.OFFICE_HOURS_OVERLAP,
            params: { other: p.other },
          }
        : {
            field: `windows.${p.index}.endMinute`,
            code: FieldErrorCode.INVALID_SCHEDULE,
          },
    );
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid office hours',
        { fields },
      );
    const tenantId = this.ctx.tenantId;
    const windows = sortedWindows(input.map(plain));
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.settings.lock(tx);
      const before = await this.inTx(tx);
      await tx.managementOfficeHours.deleteMany({});
      await tx.managementOfficeHours.createMany({
        data: windows.map((w) => ({ id: newId(), tenantId, ...w })),
      });
      const changes = diffChanges(
        { windows: before.map(windowCode) },
        { windows: windows.map(windowCode) },
        'management.office_hours_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'management.office_hours_changed',
          targetId: tenantId,
          changes,
        });
      return windows;
    });
  }
}
