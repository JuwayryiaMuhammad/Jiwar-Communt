import { Injectable } from '@nestjs/common';
import type { GateSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  GATE_SETTING_NAMES,
  type GateSettingsValues,
} from './gate-settings-rules';

/** A feature that follows a setting runs in the change's transaction. */
export type GateSettingsChangeHandler = (
  tx: TenantTxClient,
  before: GateSettingsValues,
  after: GateSettingsValues,
) => Promise<void>;

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
 *
 * Face checks (ADR 0068) are turned on only with the management's word
 * that a visible notice is posted at the gate (`faceChecksNoticePosted`),
 * which the audit keeps; the gallery follows the switch in the change's
 * transaction (`onChanged`).
 */
@Injectable()
export class GateSettingsService {
  private readonly changed: GateSettingsChangeHandler[] = [];

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Runs after every change, in its transaction (ADR 0068: the face gallery). */
  onChanged(handler: GateSettingsChangeHandler): void {
    this.changed.push(handler);
  }

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
  update(
    input: Partial<GateSettingsValues> & { faceChecksNoticePosted?: boolean },
  ): Promise<GateSettingsValues> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await tx.$queryRaw`
        SELECT tenant_id FROM gate_settings
         WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const before = await this.read(tx);
      const facesOn = input.faceChecks === true && !before.faceChecks;
      if (facesOn && input.faceChecksNoticePosted !== true)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Post the notice at the gate first',
          {
            fields: [
              {
                field: 'faceChecksNoticePosted',
                code: FieldErrorCode.FIELD_REQUIRED,
              },
            ],
          },
        );
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
      if (Object.keys(changes).length) {
        await this.audit.record(tx, {
          action: 'gate_settings.changed',
          targetId: tenantId,
          changes,
          ...(facesOn ? { metadata: { faceChecksNoticePosted: true } } : {}),
        });
        for (const handler of this.changed) await handler(tx, before, after);
      }
      return after;
    });
  }
}
