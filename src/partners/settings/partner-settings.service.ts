import { Injectable } from '@nestjs/common';
import type { PartnerSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import type { PartnerSettingName } from './defaults';

export type PartnerSettingsView = Record<PartnerSettingName, number>;

function view(s: PartnerSettings): PartnerSettingsView {
  return {
    newDays: s.newDays,
    lateFromMinute: s.lateFromMinute,
    maxLiveRequests: s.maxLiveRequests,
    ratingDays: s.ratingDays,
    complaintDays: s.complaintDays,
    deskLinkDays: s.deskLinkDays,
  };
}

/**
 * A compound's partner settings (ADR 0060): one row per compound, created
 * with it. Managed with `partners.manage`. A write that decides by them
 * reads the row with `share`, after the partner's row in the lock order,
 * so a change waits for it.
 */
@Injectable()
export class PartnerSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  inTx(tx: TenantTxClient): Promise<PartnerSettings> {
    return tx.partnerSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  /** The row, shared-locked: after the partner's row in the lock order. */
  async share(tx: TenantTxClient): Promise<PartnerSettings> {
    await tx.$queryRaw`
      SELECT tenant_id FROM partner_settings
       WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR SHARE`;
    return this.inTx(tx);
  }

  /** The row, locked for a write that counts the compound's partners. */
  async lockForUpdate(tx: TenantTxClient): Promise<PartnerSettings> {
    await tx.$queryRaw`
      SELECT tenant_id FROM partner_settings
       WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR UPDATE`;
    return this.inTx(tx);
  }

  async get(): Promise<PartnerSettingsView> {
    return view(await this.tenantTx.withTenantTx((tx) => this.inTx(tx)));
  }

  /**
   * New settings apply from the next decision: a request already made, a
   * desk link already issued and a rating window already open keep what
   * they were given.
   */
  update(input: Partial<PartnerSettingsView>): Promise<PartnerSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lockForUpdate(tx);
      const after = await tx.partnerSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          newDays: input.newDays,
          lateFromMinute: input.lateFromMinute,
          maxLiveRequests: input.maxLiveRequests,
          ratingDays: input.ratingDays,
          complaintDays: input.complaintDays,
          deskLinkDays: input.deskLinkDays,
        },
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'partner.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'partner.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
