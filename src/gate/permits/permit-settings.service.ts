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
import { localDate } from '../../core/common/slots/day-slots';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import {
  minuteOf,
  PERMIT_LIMITS,
  timeOf,
  workRules,
  type WorkRules,
} from './permit-rules';

/** The compound's permit rules as the management sets them. */
export interface PermitSettingsView {
  workDays: number[];
  workHours: { from: string; to: string };
  daysOff: string[];
}

/** What a resident needs to ask for a permit that fits. */
export interface PermitRulesView extends PermitSettingsView {
  timeZone: string;
  limits: typeof PERMIT_LIMITS;
}

export interface PermitSettingsUpdate {
  workDays?: number[];
  workHours?: { from: string; to: string };
  daysOff?: string[];
}

function view(rules: WorkRules): PermitSettingsView {
  return {
    workDays: rules.workDays,
    workHours: { from: timeOf(rules.workFrom), to: timeOf(rules.workTo) },
    daysOff: rules.daysOff,
  };
}

/**
 * A compound's permit rules (ADR 0049): one row per compound, created with
 * it, managed with `permits.manage`. A request reads the row FOR SHARE, so
 * a change waits for it; the guard reads it as it stands at each entry, so
 * a narrower window applies to the next entry, never to one recorded.
 */
@Injectable()
export class PermitSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly settings: TenantSettingsService,
  ) {}

  /** The rules, inside the caller's transaction; `share` waits for a change. */
  async rules(
    tx: TenantTxClient,
    tenantId: string,
    lock: 'share' | 'none' = 'none',
  ): Promise<WorkRules> {
    if (lock === 'share')
      await tx.$queryRaw`
        SELECT tenant_id FROM permit_settings
         WHERE tenant_id = ${tenantId}::uuid FOR SHARE`;
    return workRules(
      await tx.permitSettings.findUniqueOrThrow({ where: { tenantId } }),
    );
  }

  async get(): Promise<PermitSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) =>
      view(await this.rules(tx, this.ctx.tenantId)),
    );
  }

  /** The rules for the apps: the days off from today on, and the limits. */
  async forResidents(): Promise<PermitRulesView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rules = await this.rules(tx, this.ctx.tenantId);
      const { timezone } = await this.settings.inTx(tx, this.ctx.tenantId);
      const today = localDate(await dbNow(tx), timezone);
      return {
        ...view({
          ...rules,
          daysOff: rules.daysOff.filter((d) => d >= today),
        }),
        timeZone: timezone,
        limits: PERMIT_LIMITS,
      };
    });
  }

  update(input: PermitSettingsUpdate): Promise<PermitSettingsView> {
    const fields: FieldError[] = [];
    if (
      input.workHours &&
      minuteOf(input.workHours.to) <= minuteOf(input.workHours.from)
    )
      fields.push({
        field: 'workHours.to',
        code: FieldErrorCode.ENDS_BEFORE_START,
      });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid permit settings',
        { fields },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.tenantId;
      await tx.$queryRaw`
        SELECT tenant_id FROM permit_settings
         WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const before = await this.rules(tx, tenantId);
      const after = workRules(
        await tx.permitSettings.update({
          where: { tenantId },
          data: {
            workDays: input.workDays && [...new Set(input.workDays)].sort(),
            workFrom: input.workHours && minuteOf(input.workHours.from),
            workTo: input.workHours && minuteOf(input.workHours.to),
            daysOff:
              input.daysOff &&
              [...new Set(input.daysOff)]
                .sort()
                .map((d) => new Date(`${d}T00:00:00.000Z`)),
          },
        }),
      );
      const changes = diffChanges(
        { ...view(before) },
        { ...view(after) },
        'permit_settings.changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'permit_settings.changed',
          targetId: tenantId,
          changes,
        });
      return view(after);
    });
  }
}
