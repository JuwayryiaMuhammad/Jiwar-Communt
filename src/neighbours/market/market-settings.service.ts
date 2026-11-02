import { Injectable } from '@nestjs/common';
import {
  MarketListingCategory,
  type MarketListingKind,
  type MarketSettings,
} from '@prisma/client';
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
  // ADR 0083: listings one unit may have open at once, whoever posts them.
  maxLivePerUnit: { min: 1, max: 50, default: 10 },
} as const;

/** Every category the market knows (ADR 0071's closed list). */
export const MARKET_CATEGORIES = Object.values(
  MarketListingCategory,
) as MarketListingCategory[];

/**
 * A commercial listing (ADR 0083): a service offered, or anything posted
 * under a shop. Refused while the compound blocks commercial listings.
 */
export const isCommercial = (l: {
  kind: MarketListingKind;
  shopId?: string | null;
}): boolean => l.kind === 'service' || !!l.shopId;
export type MarketNumberSetting = keyof typeof MARKET_SETTING_RANGES;

export interface MarketSettingsView {
  requiresReview: boolean;
  maxLivePerAccount: number;
  expiryDays: number;
  reportHideThreshold: number;
  /** ADR 0083: no services and nothing under a shop, while on. */
  commercialBlocked: boolean;
  /** ADR 0083: the categories a new or edited listing may take. */
  allowedCategories: MarketListingCategory[];
  maxLivePerUnit: number;
}

function view(s: MarketSettings): MarketSettingsView {
  return {
    requiresReview: s.requiresReview,
    maxLivePerAccount: s.maxLivePerAccount,
    expiryDays: s.expiryDays,
    reportHideThreshold: s.reportHideThreshold,
    commercialBlocked: s.commercialBlocked,
    allowedCategories: MARKET_CATEGORIES.filter(
      (c) => !s.blockedCategories.includes(c),
    ),
    maxLivePerUnit: s.maxLivePerUnit,
  };
}

/** Whether a listing may take this category now (ADR 0083). */
export const categoryAllowed = (
  s: MarketSettings,
  category: MarketListingCategory,
): boolean => !s.blockedCategories.includes(category);

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
   * nobody loses a listing already open to a lower limit, a category taken
   * off or the commercial block (ADR 0083): those are refused on a new
   * listing or an edit only. The categories are stored as those taken off,
   * so a category the market adds later is allowed until taken off.
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
          commercialBlocked: input.commercialBlocked,
          maxLivePerUnit: input.maxLivePerUnit,
          blockedCategories:
            input.allowedCategories === undefined
              ? undefined
              : MARKET_CATEGORIES.filter(
                  (c) => !input.allowedCategories!.includes(c),
                ),
        },
      });
      const flat = (v: MarketSettingsView) => ({
        ...v,
        allowedCategories: v.allowedCategories.join(','),
      });
      const changes = diffChanges(
        flat(view(before)),
        flat(view(after)),
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
