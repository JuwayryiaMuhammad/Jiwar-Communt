import { Injectable } from '@nestjs/common';
import type { TenantSettings } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { RequestContext } from '../common/cls/request-context';
import { normalizePhone } from '../auth/identifier';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';

export interface TenantSettingsView {
  familyJoinRequiresApproval: boolean;
  maxHouseholdMembers: number;
  /** IANA time zone; worker schedules are read in it (ADR 0017). */
  timezone: string;
  /** Active visitor passes per unit (ADR 0028). */
  maxActiveVisitorPasses: number;
  /** Seconds a household has to answer the gate before its instruction applies. */
  gateRequestTimeoutSeconds: number;
  /** Free text for visitors, on the public page (ADR 0030). */
  visitorDirections: string | null;
  /** E.164; on the visitor page and the worker card (ADR 0030). */
  emergencyPhone: string | null;
}

/** Absent keeps a value; `null` clears the two optional texts. */
export type TenantSettingsUpdate = Partial<TenantSettingsView>;

export const MAX_HOUSEHOLD_MEMBERS = { min: 1, max: 100 } as const;
export const MAX_ACTIVE_VISITOR_PASSES = { min: 1, max: 500 } as const;
export const GATE_REQUEST_TIMEOUT_SECONDS = { min: 30, max: 1800 } as const;
export const VISITOR_DIRECTIONS_LENGTH = { min: 1, max: 2000 } as const;

/** An integer in range, else the field error the DTO would give. */
function checkRange(
  field: string,
  value: number | undefined,
  range: { min: number; max: number },
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < range.min || value > range.max)
  ) {
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, `Invalid ${field}`, {
      fields: [
        { field, code: FieldErrorCode.INVALID_NUMBER, params: { ...range } },
      ],
    });
  }
}

/**
 * A compound's own settings (ADR 0016): one row per compound, created with
 * it. Read and changed by its managers (`settings.manage`, GET/PATCH
 * /settings); domains read it inside their transactions with `inTx`.
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
    checkRange(
      'maxActiveVisitorPasses',
      input.maxActiveVisitorPasses,
      MAX_ACTIVE_VISITOR_PASSES,
    );
    checkRange(
      'gateRequestTimeoutSeconds',
      input.gateRequestTimeoutSeconds,
      GATE_REQUEST_TIMEOUT_SECONDS,
    );
    if (input.timezone !== undefined && !isTimeZone(input.timezone)) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Unknown time zone',
        {
          fields: [{ field: 'timezone', code: FieldErrorCode.INVALID_VALUE }],
        },
      );
    }
    const directions = checkDirections(input.visitorDirections);
    const phone = checkPhone(input.emergencyPhone);
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.inTx(tx, tenantId);
      const after = await tx.tenantSettings.update({
        where: { tenantId },
        data: {
          familyJoinRequiresApproval: input.familyJoinRequiresApproval,
          maxHouseholdMembers: input.maxHouseholdMembers,
          timezone: input.timezone,
          maxActiveVisitorPasses: input.maxActiveVisitorPasses,
          gateRequestTimeoutSeconds: input.gateRequestTimeoutSeconds,
          visitorDirections: directions,
          emergencyPhone: phone,
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
    maxActiveVisitorPasses: row.maxActiveVisitorPasses,
    gateRequestTimeoutSeconds: row.gateRequestTimeoutSeconds,
    visitorDirections: row.visitorDirections,
    emergencyPhone: row.emergencyPhone,
  };
}

/** Trimmed, 1–2000 characters; `null` clears, absent keeps. */
function checkDirections(value: string | null | undefined) {
  if (value === undefined || value === null) return value;
  const text = value.trim();
  if (
    text.length < VISITOR_DIRECTIONS_LENGTH.min ||
    text.length > VISITOR_DIRECTIONS_LENGTH.max
  )
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Invalid visitor directions',
      {
        fields: [
          {
            field: 'visitorDirections',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { ...VISITOR_DIRECTIONS_LENGTH },
          },
        ],
      },
    );
  return text;
}

/** Stored in E.164; `null` clears, absent keeps. */
function checkPhone(value: string | null | undefined) {
  if (value === undefined || value === null) return value;
  const e164 = normalizePhone(value);
  if (!e164)
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Invalid emergency phone',
      {
        fields: [
          { field: 'emergencyPhone', code: FieldErrorCode.INVALID_PHONE },
        ],
      },
    );
  return e164;
}

/** An IANA zone the runtime knows (plus UTC, which some lists omit). */
export function isTimeZone(value: string): boolean {
  return value === 'UTC' || Intl.supportedValuesOf('timeZone').includes(value);
}
