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
import { readWorkRules } from './permit-work-rules';

/** The compound's permit rules as the management sets them. */
export interface PermitSettingsView {
  workDays: number[];
  workHours: { from: string; to: string };
  daysOff: string[];
  /** A works permit is approved only once its deposit holds money (ADR 0074). */
  worksDepositRequired: boolean;
}

/** What a resident needs to ask for a permit that fits. */
export interface PermitRulesView extends PermitSettingsView {
  timeZone: string;
  limits: typeof PERMIT_LIMITS;
}

/** The days off are the calendar's (ADR 0084): changed there, not here. */
export interface PermitSettingsUpdate {
  workDays?: number[];
  workHours?: { from: string; to: string };
  worksDepositRequired?: boolean;
}

function view(
  rules: WorkRules,
  worksDepositRequired: boolean,
): PermitSettingsView {
  return {
    workDays: rules.workDays,
    workHours: { from: timeOf(rules.workFrom), to: timeOf(rules.workTo) },
    daysOff: rules.daysOff,
    worksDepositRequired,
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

  /**
   * The rules, inside the caller's transaction; `share` waits for a change
   * of the rules or of the calendar's days off (ADR 0084).
   */
  rules(
    tx: TenantTxClient,
    tenantId: string,
    lock: 'share' | 'none' = 'none',
  ): Promise<WorkRules> {
    return readWorkRules(tx, tenantId, lock);
  }

  /** Whether a works permit waits for its deposit (ADR 0074). */
  async worksDepositRequired(
    tx: TenantTxClient,
    tenantId: string,
  ): Promise<boolean> {
    return (
      await tx.permitSettings.findUniqueOrThrow({
        where: { tenantId },
        select: { worksDepositRequired: true },
      })
    ).worksDepositRequired;
  }

  async get(): Promise<PermitSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) =>
      view(
        await this.rules(tx, this.ctx.tenantId),
        await this.worksDepositRequired(tx, this.ctx.tenantId),
      ),
    );
  }

  /** The rules for the apps: the days off from today on, and the limits. */
  async forResidents(): Promise<PermitRulesView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rules = await this.rules(tx, this.ctx.tenantId);
      const { timezone } = await this.settings.inTx(tx, this.ctx.tenantId);
      const today = localDate(await dbNow(tx), timezone);
      return {
        ...view(
          {
            ...rules,
            daysOff: rules.daysOff.filter((d) => d >= today),
          },
          await this.worksDepositRequired(tx, this.ctx.tenantId),
        ),
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
      const depositBefore = await this.worksDepositRequired(tx, tenantId);
      const row = await tx.permitSettings.update({
        where: { tenantId },
        data: {
          worksDepositRequired: input.worksDepositRequired,
          workDays: input.workDays && [...new Set(input.workDays)].sort(),
          workFrom: input.workHours && minuteOf(input.workHours.from),
          workTo: input.workHours && minuteOf(input.workHours.to),
        },
      });
      const after = workRules(row, before.daysOff);
      const changes = diffChanges(
        { ...view(before, depositBefore) },
        { ...view(after, row.worksDepositRequired) },
        'permit_settings.changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'permit_settings.changed',
          targetId: tenantId,
          changes,
        });
      return view(after, row.worksDepositRequired);
    });
  }
}
