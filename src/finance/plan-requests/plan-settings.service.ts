import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FinanceAccess } from '../access';
import { money, MONEY, show } from '../money';

// A type, not an interface: the audit's diff takes a plain record.
export type PlanSettings = {
  planMaxMonths: number;
  planOfferMinAmount: string | null;
};

/**
 * The compound's payment plan terms for residents (ADR 0069): the most
 * months a request may ask, and from what an invoice still owes its
 * due-soon notice offers a plan (null: never). They apply to requests and
 * notices from then on.
 */
@Injectable()
export class PlanSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: FinanceAccess,
  ) {}

  get(): Promise<PlanSettings> {
    return this.tenantTx.withTenantTx((tx) => this.read(tx));
  }

  set(input: {
    planMaxMonths?: number;
    planOfferMinAmount?: string | null;
  }): Promise<PlanSettings> {
    if (
      typeof input.planOfferMinAmount === 'string' &&
      !MONEY.test(input.planOfferMinAmount)
    )
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid request',
        {
          fields: [
            {
              field: 'planOfferMinAmount',
              code: FieldErrorCode.INVALID_FORMAT,
            },
          ],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings
         WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR UPDATE`;
      const before = await this.read(tx);
      const after: PlanSettings = {
        planMaxMonths: input.planMaxMonths ?? before.planMaxMonths,
        planOfferMinAmount:
          input.planOfferMinAmount === undefined
            ? before.planOfferMinAmount
            : input.planOfferMinAmount === null
              ? null
              : show(input.planOfferMinAmount),
      };
      const changes = diffChanges(
        before,
        after,
        'finance.plan_settings_changed',
      );
      if (!Object.keys(changes).length) return before;
      await tx.financeSettings.update({
        where: { tenantId: this.ctx.txTenantId },
        data: {
          planMaxMonths: after.planMaxMonths,
          planOfferMinAmount:
            after.planOfferMinAmount === null
              ? null
              : money(after.planOfferMinAmount),
        },
      });
      await this.audit.record(tx, {
        action: 'finance.plan_settings_changed',
        targetId: this.ctx.txTenantId,
        changes,
      });
      return after;
    });
  }

  private async read(tx: TenantTxClient): Promise<PlanSettings> {
    const s = await tx.financeSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
      select: { planMaxMonths: true, planOfferMinAmount: true },
    });
    return {
      planMaxMonths: s.planMaxMonths,
      planOfferMinAmount:
        s.planOfferMinAmount === null ? null : show(s.planOfferMinAmount),
    };
  }
}
