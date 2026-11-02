import { Injectable } from '@nestjs/common';
import type { MaintenanceSlaSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';

/** ADR 0076: the at-risk share (%) of a clock's target, per priority; null for none. */
export interface SlaAtRiskPercent {
  normal: number | null;
  urgent: number | null;
  emergency: number | null;
}

export interface SlaSettingsView {
  /** Off for every compound until the manager turns it on. */
  slaEnabled: boolean;
  /** The last time it was turned on; clocks never start before it. */
  enabledAt: Date | null;
  atRiskPercent: SlaAtRiskPercent;
  updatedAt: Date;
}

export const AT_RISK_PERCENT = { min: 50, max: 95 };
const PRIORITIES = ['normal', 'urgent', 'emergency'] as const;

export interface SlaSettingsChange extends SlaSettingsView {
  /** This change turned the SLA on (or off). */
  turnedOn: boolean;
  turnedOff: boolean;
}

function view(s: MaintenanceSlaSettings): SlaSettingsView {
  return {
    slaEnabled: s.slaEnabled,
    enabledAt: s.enabledAt,
    atRiskPercent: {
      normal: s.atRiskPercentNormal,
      urgent: s.atRiskPercentUrgent,
      emergency: s.atRiskPercentEmergency,
    },
    updatedAt: s.updatedAt,
  };
}

const COLUMN = {
  normal: 'atRiskPercentNormal',
  urgent: 'atRiskPercentUrgent',
  emergency: 'atRiskPercentEmergency',
} as const;

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

  /**
   * The escalation levels (ADR 0076): the at-risk share per priority, 50–95
   * or null for none. Under the row's lock, like the switch; audited as
   * `<priority>` changes. A clock already warned of stays warned; a new
   * share applies to the clocks not yet at risk.
   */
  updateEscalation(input: Partial<SlaAtRiskPercent>): Promise<SlaSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.tenantId;
      await tx.$queryRaw`
        SELECT tenant_id FROM maintenance_sla_settings
         WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const before = await this.inTx(tx);
      const changes: Record<
        string,
        { from: number | null; to: number | null }
      > = {};
      const data: Record<string, number | null> = {};
      for (const p of PRIORITIES) {
        const to = input[p];
        if (to === undefined || to === before.atRiskPercent[p]) continue;
        changes[p] = { from: before.atRiskPercent[p], to };
        data[COLUMN[p]] = to;
      }
      if (!Object.keys(data).length) return before;
      const after = view(
        await tx.maintenanceSlaSettings.update({
          where: { tenantId },
          data,
        }),
      );
      await this.audit.record(tx, {
        action: 'maintenance.sla_escalation_changed',
        targetId: tenantId,
        changes,
      });
      return after;
    });
  }
}
