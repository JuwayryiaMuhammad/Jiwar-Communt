import { Injectable } from '@nestjs/common';
import type { GateSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  GATE_SETTING_NAMES,
  type GateSettingsValues,
} from './gate-settings-rules';

function values(row: GateSettings): GateSettingsValues {
  return Object.fromEntries(
    GATE_SETTING_NAMES.map((name) => [name, row[name]]),
  ) as GateSettingsValues;
}

/**
 * The gate's settings (ADR 0056): one row per compound, created with it,
 * managed with `gate.manage`. A write that depends on a value reads the
 * row FOR SHARE, so a change waits for it and never applies halfway; a
 * change locks the row FOR UPDATE. What was decided under the old values
 * keeps them (an exception's deadline is written on it).
 */
@Injectable()
export class GateSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** The row, inside the caller's transaction; `share` waits for a change. */
  async read(
    tx: TenantTxClient,
    lock: 'share' | 'none' = 'none',
  ): Promise<GateSettingsValues> {
    const tenantId = this.ctx.txTenantId;
    if (lock === 'share')
      await tx.$queryRaw`
        SELECT tenant_id FROM gate_settings
         WHERE tenant_id = ${tenantId}::uuid FOR SHARE`;
    return values(
      await tx.gateSettings.findUniqueOrThrow({ where: { tenantId } }),
    );
  }

  get(): Promise<GateSettingsValues> {
    return this.tenantTx.withTenantTx((tx) => this.read(tx));
  }

  /** Changes what was given; the bounds are the DTO's and the table's. */
  update(input: Partial<GateSettingsValues>): Promise<GateSettingsValues> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await tx.$queryRaw`
        SELECT tenant_id FROM gate_settings
         WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const before = await this.read(tx);
      const data = Object.fromEntries(
        GATE_SETTING_NAMES.filter((n) => input[n] !== undefined).map((n) => [
          n,
          input[n],
        ]),
      );
      const after = values(
        await tx.gateSettings.update({ where: { tenantId }, data }),
      );
      const changes = diffChanges(
        { ...before },
        { ...after },
        'gate_settings.changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'gate_settings.changed',
          targetId: tenantId,
          changes,
        });
      return after;
    });
  }
}
