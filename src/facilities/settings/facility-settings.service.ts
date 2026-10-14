import { Injectable } from '@nestjs/common';
import type { FacilitySettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import type { FacilitySettingName } from './defaults';

export type FacilitySettingsView = Record<FacilitySettingName, number>;

function view(s: FacilitySettings): FacilitySettingsView {
  return {
    noShowThreshold: s.noShowThreshold,
    noShowWindowDays: s.noShowWindowDays,
    suspensionDays: s.suspensionDays,
  };
}

/**
 * A compound's facility settings (ADR 0044): one row per compound, created
 * with it. Managed with `facilities.manage`. A no-show reads it with
 * `share`, so a change of the rules waits for a suspension being decided.
 */
@Injectable()
export class FacilitySettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  inTx(tx: TenantTxClient): Promise<FacilitySettings> {
    return tx.facilitySettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  /** The row, shared-locked: after the booking's row in the lock order. */
  async share(tx: TenantTxClient): Promise<FacilitySettings> {
    await tx.$queryRaw`
      SELECT tenant_id FROM facility_settings
       WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR SHARE`;
    return this.inTx(tx);
  }

  async get(): Promise<FacilitySettingsView> {
    return view(await this.tenantTx.withTenantTx((tx) => this.inTx(tx)));
  }

  /** New rules apply to the next no-show; a suspension in force keeps its end. */
  update(input: Partial<FacilitySettingsView>): Promise<FacilitySettingsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`
        SELECT tenant_id FROM facility_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await this.inTx(tx);
      const after = await tx.facilitySettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          noShowThreshold: input.noShowThreshold,
          noShowWindowDays: input.noShowWindowDays,
          suspensionDays: input.suspensionDays,
        },
      });
      const changes = diffChanges(
        view(before),
        view(after),
        'facility.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'facility.settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
