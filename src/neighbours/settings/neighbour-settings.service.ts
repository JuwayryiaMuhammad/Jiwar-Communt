import { Injectable } from '@nestjs/common';
import type { NeighbourSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import type { NeighbourSettingName } from './defaults';

export type NeighbourSettingsView = Record<NeighbourSettingName, number>;

function view(s: NeighbourSettings): NeighbourSettingsView {
  return {
    maxOpenComplaints: s.maxOpenComplaints,
    lostFoundExpiryDays: s.lostFoundExpiryDays,
    lendingExpiryDays: s.lendingExpiryDays,
    maxOpenPosts: s.maxOpenPosts,
    maxNewConversationsPerDay: s.maxNewConversationsPerDay,
  };
}

/**
 * A compound's neighbours settings (ADR 0042): one row per compound,
 * created with it. Managed with `neighbours.manage`; the domain reads it
 * inside its own transactions with `share`, so a limit cannot change under
 * a write that is being counted against it.
 */
@Injectable()
export class NeighbourSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  inTx(tx: TenantTxClient): Promise<NeighbourSettings> {
    return tx.neighbourSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  /** The row, shared-locked: last in the lock order. */
  async share(tx: TenantTxClient): Promise<NeighbourSettings> {
    await tx.$queryRaw`
      SELECT tenant_id FROM neighbour_settings
       WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR SHARE`;
    return this.inTx(tx);
  }

  async get(): Promise<NeighbourSettingsView> {
    return view(await this.tenantTx.withTenantTx((tx) => this.inTx(tx)));
  }

  /**
   * A new limit applies to what is written from now on: a post keeps the
   * day it was given, and nobody loses a complaint already open.
   */
  update(
    input: Partial<NeighbourSettingsView>,
  ): Promise<NeighbourSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`
        SELECT tenant_id FROM neighbour_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await this.inTx(tx);
      const after = await tx.neighbourSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          maxOpenComplaints: input.maxOpenComplaints,
          lostFoundExpiryDays: input.lostFoundExpiryDays,
          lendingExpiryDays: input.lendingExpiryDays,
          maxOpenPosts: input.maxOpenPosts,
          maxNewConversationsPerDay: input.maxNewConversationsPerDay,
        },
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'neighbours.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'neighbours.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
