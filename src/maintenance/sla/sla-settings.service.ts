import { Injectable } from '@nestjs/common';
import type { MaintenanceSlaSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';

export interface SlaSettingsView {
  /** Off for every compound until the manager turns it on. */
  slaEnabled: boolean;
  /** The last time it was turned on; clocks never start before it. */
  enabledAt: Date | null;
  updatedAt: Date;
}

export interface SlaSettingsChange extends SlaSettingsView {
  /** This change turned the SLA on (or off). */
  turnedOn: boolean;
  turnedOff: boolean;
}

function view(s: MaintenanceSlaSettings): SlaSettingsView {
  return {
    slaEnabled: s.slaEnabled,
    enabledAt: s.enabledAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * A compound's SLA switch (ADR 0034). Off everywhere until the manager turns
 * it on: while it is off nothing is recorded and nobody is told. Turning it
 * on or off is this row alone, in a short transaction of its own; the
 * clocks of the open tickets are started (or stopped) afterwards, ticket by
 * ticket (SlaActivation), never by locking every ticket at once.
 */
@Injectable()
export class SlaSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** The compound's row, in the caller's transaction (a request's or a sweep's). */
  async inTx(tx: TenantTxClient): Promise<SlaSettingsView> {
    return view(
      await tx.maintenanceSlaSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.txTenantId },
      }),
    );
  }

  get(): Promise<SlaSettingsView> {
    return this.tenantTx.withTenantTx((tx) => this.inTx(tx));
  }

  update(input: { slaEnabled?: boolean }): Promise<SlaSettingsChange> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.tenantId;
      await tx.$queryRaw`
        SELECT tenant_id FROM maintenance_sla_settings
         WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const before = await this.inTx(tx);
      const turnedOn = input.slaEnabled === true && !before.slaEnabled;
      const turnedOff = input.slaEnabled === false && before.slaEnabled;
      if (!turnedOn && !turnedOff)
        return { ...before, turnedOn: false, turnedOff: false };
      const after = view(
        await tx.maintenanceSlaSettings.update({
          where: { tenantId },
          data: turnedOn
            ? { slaEnabled: true, enabledAt: await dbNow(tx) }
            : { slaEnabled: false },
        }),
      );
      await this.audit.record(tx, {
        action: 'maintenance.sla_settings_changed',
        targetId: tenantId,
        changes: {
          slaEnabled: { from: before.slaEnabled, to: after.slaEnabled },
        },
      });
      return { ...after, turnedOn, turnedOff };
    });
  }
}
