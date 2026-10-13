import { Injectable } from '@nestjs/common';
import type { EngagementSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';

export type EngagementSettingsView = {
  /** Guests one "going" answer to an event may bring, at most. */
  eventMaxGuests: number;
};

/** The CHECK engagement_settings_ranges. */
export const EVENT_MAX_GUESTS = { min: 0, max: 20 } as const;

function view(s: EngagementSettings): EngagementSettingsView {
  return { eventMaxGuests: s.eventMaxGuests };
}

/**
 * A compound's community settings (ADR 0040): one row per compound,
 * created with it. Managed with `community.publish`; the domain reads it
 * inside its own transactions with `inTx`.
 */
@Injectable()
export class EngagementSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  inTx(tx: TenantTxClient): Promise<EngagementSettings> {
    return tx.engagementSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  async get(): Promise<EngagementSettingsView> {
    return view(await this.tenantTx.withTenantTx((tx) => this.inTx(tx)));
  }

  /**
   * A new limit applies to the answers given from now on; an answer already
   * given keeps its guests.
   */
  update(
    input: Partial<EngagementSettingsView>,
  ): Promise<EngagementSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`
        SELECT tenant_id FROM engagement_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await this.inTx(tx);
      const after = await tx.engagementSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: { eventMaxGuests: input.eventMaxGuests },
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'engagement.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'engagement.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
