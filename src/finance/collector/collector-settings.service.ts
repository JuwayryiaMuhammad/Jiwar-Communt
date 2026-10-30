import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { FinanceAccess } from '../access';
import { money, show } from '../money';

/** The most a compound lets a collector take above what a unit owes. */
export const MAX_COLLECTOR_MARGIN = money(1000);

/**
 * What a collector may take above what a unit owes (ADR 0069): the margin
 * a round sum needs, small enough that a mistyped figure never makes a
 * large credit. From the next visit on.
 */
@Injectable()
export class CollectorSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: FinanceAccess,
  ) {}

  get(): Promise<{ collectorMargin: string }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const s = await tx.financeSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.txTenantId },
        select: { collectorMargin: true },
      });
      return { collectorMargin: show(s.collectorMargin) };
    });
  }

  set(margin: string): Promise<{ collectorMargin: string }> {
    if (money(margin).gt(MAX_COLLECTOR_MARGIN))
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid request',
        {
          fields: [
            {
              field: 'collectorMargin',
              code: FieldErrorCode.INVALID_VALUE,
              params: { max: show(MAX_COLLECTOR_MARGIN) },
            },
          ],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings
         WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR UPDATE`;
      const before = await tx.financeSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.txTenantId },
        select: { collectorMargin: true },
      });
      const after = { collectorMargin: show(margin) };
      const changes = diffChanges(
        { collectorMargin: show(before.collectorMargin) },
        after,
        'finance.collector_settings_changed',
      );
      if (!Object.keys(changes).length) return after;
      await tx.financeSettings.update({
        where: { tenantId: this.ctx.txTenantId },
        data: { collectorMargin: money(margin) },
      });
      await this.audit.record(tx, {
        action: 'finance.collector_settings_changed',
        targetId: this.ctx.txTenantId,
        changes,
      });
      return after;
    });
  }
}
