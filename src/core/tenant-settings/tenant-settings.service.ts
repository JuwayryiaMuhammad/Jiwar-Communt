import { Injectable } from '@nestjs/common';
import type { TenantSettings } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';

export interface TenantSettingsView {
  familyJoinRequiresApproval: boolean;
  maxHouseholdMembers: number;
  /** IANA time zone; worker schedules are read in it (ADR 0017). */
  timezone: string;
}

export type TenantSettingsUpdate = Partial<TenantSettingsView>;

export const MAX_HOUSEHOLD_MEMBERS = { min: 1, max: 100 } as const;

/**
 * A compound's own settings (ADR 0016): one row per compound, created with
 * it. Read and changed by its managers (`settings.manage` on future
 * endpoints); domains read it inside their transactions with `inTx`.
 */
@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Creates the row for a new compound, in the compound's transaction. */
  async create(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.tenantSettings.create({ data: { tenantId } });
  }

  /** The current compound's settings, inside its transaction. */
  async inTx(tx: TenantTxClient, tenantId: string): Promise<TenantSettings> {
    return tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
  }

  async get(): Promise<TenantSettingsView> {
    const row = await this.prisma.tenant.tenantSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.tenantId },
    });
    return view(row);
  }

  async update(input: TenantSettingsUpdate): Promise<TenantSettingsView> {
    const max = input.maxHouseholdMembers;
    if (
      max !== undefined &&
      (!Number.isInteger(max) ||
        max < MAX_HOUSEHOLD_MEMBERS.min ||
        max > MAX_HOUSEHOLD_MEMBERS.max)
    ) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid household size limit',
        {
          fields: [
            {
              field: 'maxHouseholdMembers',
              code: FieldErrorCode.INVALID_NUMBER,
              params: { ...MAX_HOUSEHOLD_MEMBERS },
            },
          ],
        },
      );
    }
    if (input.timezone !== undefined && !isTimeZone(input.timezone)) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Unknown time zone',
        {
          fields: [{ field: 'timezone', code: FieldErrorCode.INVALID_VALUE }],
        },
      );
    }
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.inTx(tx, tenantId);
      const after = await tx.tenantSettings.update({
        where: { tenantId },
        data: {
          familyJoinRequiresApproval: input.familyJoinRequiresApproval,
          maxHouseholdMembers: input.maxHouseholdMembers,
          timezone: input.timezone,
        },
      });
      const changes = diffChanges(
        { ...view(before) },
        { ...view(after) },
        'tenant.settings_changed',
      );
      if (Object.keys(changes).length) {
        await this.audit.record(tx, {
          action: 'tenant.settings_changed',
          targetId: tenantId,
          changes,
        });
      }
      return view(after);
    });
  }
}

function view(row: TenantSettings): TenantSettingsView {
  return {
    familyJoinRequiresApproval: row.familyJoinRequiresApproval,
    maxHouseholdMembers: row.maxHouseholdMembers,
    timezone: row.timezone,
  };
}

/** An IANA zone the runtime knows (plus UTC, which some lists omit). */
export function isTimeZone(value: string): boolean {
  return value === 'UTC' || Intl.supportedValuesOf('timeZone').includes(value);
}
