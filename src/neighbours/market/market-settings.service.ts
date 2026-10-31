import { Injectable } from '@nestjs/common';
import type { MarketSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';

/** The CHECK market_settings_ranges, and the defaults of its columns. */
export const MARKET_SETTING_RANGES = {
  maxLivePerAccount: { min: 1, max: 50, default: 10 },
  expiryDays: { min: 1, max: 180, default: 30 },
  reportHideThreshold: { min: 1, max: 20, default: 3 },
} as const;
export type MarketNumberSetting = keyof typeof MARKET_SETTING_RANGES;

export interface MarketSettingsView {
  requiresReview: boolean;
  maxLivePerAccount: number;
  expiryDays: number;
  reportHideThreshold: number;
}

function view(s: MarketSettings): MarketSettingsView {
  return {
    requiresReview: s.requiresReview,
    maxLivePerAccount: s.maxLivePerAccount,
    expiryDays: s.expiryDays,
    reportHideThreshold: s.reportHideThreshold,
  };
}

/**
 * A compound's market settings (ADR 0071): one row per compound, created
 * with it. Managed with `market.handle`; the market reads it inside its own
 * transactions with `share`, last in its lock order, so a limit cannot
 * change under a write being counted against it.
 */
@Injectable()
export class MarketSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  inTx(tx: TenantTxClient): Promise<MarketSettings> {
    return tx.marketSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  /** The row, shared-locked: last in the lock order. */
  async share(tx: TenantTxClient): Promise<MarketSettings> {
    await tx.$queryRaw`
      SELECT tenant_id FROM market_settings
       WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR SHARE`;
    return this.inTx(tx);
  }

  async get(): Promise<MarketSettingsView> {
    return view(await this.tenantTx.withTenantTx((tx) => this.inTx(tx)));
  }

  /**
   * A new setting applies from now on: a listing keeps the day it was
   * given, a listing already live stays live when review is turned on, and
   * nobody loses a listing already open to a lower limit.
   */
  update(input: Partial<MarketSettingsView>): Promise<MarketSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`
        SELECT tenant_id FROM market_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await this.inTx(tx);
      const after = await tx.marketSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          requiresReview: input.requiresReview,
          maxLivePerAccount: input.maxLivePerAccount,
          expiryDays: input.expiryDays,
          reportHideThreshold: input.reportHideThreshold,
        },
      });
      const changes = diffChanges(
        { ...view(before) },
        { ...view(after) },
        'market.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'market.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
