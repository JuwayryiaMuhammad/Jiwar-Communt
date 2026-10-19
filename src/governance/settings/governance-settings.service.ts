import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type GovernanceApprovalSetting } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import {
  BoardMatters,
  type ThresholdType,
} from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  SETTING_TYPES,
  THRESHOLD_TYPES,
  type SettingType,
} from '../approvals/approval-rules';

export interface GovernanceSettingView {
  type: SettingType;
  deadlineDays: number;
  /** A decimal string, or null; always null for a type without one. */
  threshold: string | null;
  thresholded: boolean;
}

const thresholded = (type: string): type is ThresholdType =>
  (THRESHOLD_TYPES as readonly string[]).includes(type);

function view(s: GovernanceApprovalSetting): GovernanceSettingView {
  return {
    type: s.type as SettingType,
    deadlineDays: s.deadlineDays,
    threshold: s.threshold ? s.threshold.toFixed(2) : null,
    thresholded: thresholded(s.type),
  };
}

/** The flat form the audit diffs: `<type>.deadlineDays`, `<type>.threshold`. */
function flat(rows: GovernanceSettingView[]): Record<string, unknown> {
  return Object.fromEntries(
    rows.flatMap((r): [string, unknown][] => [
      [`${r.type}.deadlineDays`, r.deadlineDays],
      [`${r.type}.threshold`, r.threshold],
    ]),
  );
}

/**
 * A compound's deadlines and thresholds for the board's matters (ADR
 * 0055): a row per approval type and one for appeals to the board, created
 * with the compound. Managed with `governance.manage`. A matter takes its
 * deadline when raised; an expense reads the manager's limit
 * (`major_contract`'s threshold) shared, so a change waits for it.
 */
@Injectable()
export class GovernanceSettingsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly matters: BoardMatters,
  ) {}

  onModuleInit(): void {
    this.matters.registerThresholds((tx, type) => this.threshold(tx, type));
  }

  /** The type's threshold, its row shared-locked. */
  async threshold(
    tx: TenantTxClient,
    type: ThresholdType,
  ): Promise<string | null> {
    const [row] = await tx.$queryRaw<{ threshold: Prisma.Decimal | null }[]>`
      SELECT threshold FROM governance_approval_settings
       WHERE tenant_id = ${this.ctx.txTenantId}::uuid AND type = ${type}
       FOR SHARE`;
    return row?.threshold ? new Prisma.Decimal(row.threshold).toFixed(2) : null;
  }

  /** How many days the board has for a matter of the type raised now (a plain read). */
  async deadlineDays(tx: TenantTxClient, type: SettingType): Promise<number> {
    const row = await tx.governanceApprovalSetting.findUniqueOrThrow({
      where: { tenantId_type: { tenantId: this.ctx.txTenantId, type } },
    });
    return row.deadlineDays;
  }

  get(): Promise<GovernanceSettingView[]> {
    return this.tenantTx.withTenantTx(async (tx) => this.all(tx));
  }

  update(
    items: {
      type: SettingType;
      deadlineDays?: number;
      threshold?: string | null;
    }[],
  ): Promise<GovernanceSettingView[]> {
    const fields: FieldError[] = [];
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.type))
        fields.push({
          field: `items[${i}].type`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      seen.add(item.type);
      if (item.threshold !== undefined && !thresholded(item.type))
        fields.push({
          field: `items[${i}].threshold`,
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    });
    if (fields.length) throw invalid(fields);
    const types = [...seen].sort();
    return this.tenantTx.withTenantTx(async (tx) => {
      // Only the rows that change, in one order: an expense holds its one.
      await tx.$queryRaw`
        SELECT type FROM governance_approval_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid AND type = ANY(${types}::text[])
         ORDER BY type FOR UPDATE`;
      const before = await this.all(tx);
      for (const item of items)
        await tx.governanceApprovalSetting.update({
          where: {
            tenantId_type: { tenantId: this.ctx.tenantId, type: item.type },
          },
          data: {
            deadlineDays: item.deadlineDays,
            threshold: item.threshold,
            updatedAt: new Date(),
          },
        });
      const after = await this.all(tx);
      const changes = diffChanges(
        flat(before),
        flat(after),
        'governance_settings.changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'governance_settings.changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return after;
    });
  }

  private async all(tx: TenantTxClient): Promise<GovernanceSettingView[]> {
    const rows = await tx.governanceApprovalSetting.findMany();
    const order = (t: string) =>
      (SETTING_TYPES as readonly string[]).indexOf(t);
    return rows.sort((a, b) => order(a.type) - order(b.type)).map(view);
  }
}
