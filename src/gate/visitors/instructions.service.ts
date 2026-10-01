import { Injectable } from '@nestjs/common';
import type { DeliveryInstruction, VisitorInstruction } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';

export interface GateInstructions {
  uninvitedVisitor: VisitorInstruction;
  delivery: DeliveryInstruction;
  updatedAt: Date | null;
}

/** Nobody set anything: the household is asked every time. */
export const DEFAULT_INSTRUCTIONS = {
  uninvitedVisitor: 'ask',
  delivery: 'ask',
} as const;

/**
 * A household's standing instructions for the gate (ADR 0028): what the
 * guard does with an uninvited visitor or a delivery when nobody answers in
 * time. Set by the unit's primary (or a `household` delegate); read by the
 * approvals at their timeout.
 */
@Injectable()
export class InstructionsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly community: CommunityGatePort,
  ) {}

  get(unitId: string): Promise<GateInstructions> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.community.requireHousehold(tx, unitId);
      return this.of(tx, unitId);
    });
  }

  set(
    unitId: string,
    input: {
      uninvitedVisitor: VisitorInstruction;
      delivery: DeliveryInstruction;
    },
  ): Promise<GateInstructions> {
    const tenantId = this.ctx.tenantId;
    const by = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.community.requireHousehold(tx, unitId);
      const before = await this.of(tx, unitId);
      const row = await tx.unitGateInstruction.upsert({
        where: { tenantId_unitId: { tenantId, unitId } },
        create: { tenantId, unitId, ...input, updatedById: by },
        update: { ...input, updatedById: by },
      });
      const changes = diffChanges(
        {
          uninvitedVisitor: before.uninvitedVisitor,
          delivery: before.delivery,
        },
        { uninvitedVisitor: row.uninvitedVisitor, delivery: row.delivery },
        'gate.instructions_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'gate.instructions_changed',
          targetId: unitId,
          changes,
        });
      return {
        uninvitedVisitor: row.uninvitedVisitor,
        delivery: row.delivery,
        updatedAt: row.updatedAt,
      };
    });
  }

  /** In the caller's transaction (the approvals read it at timeout). */
  async of(tx: TenantTxClient, unitId: string): Promise<GateInstructions> {
    // By unit only: the sweep reads this without a request tenant, and RLS
    // already scopes the row to the transaction's compound.
    const row = await tx.unitGateInstruction.findFirst({ where: { unitId } });
    return row
      ? {
          uninvitedVisitor: row.uninvitedVisitor,
          delivery: row.delivery,
          updatedAt: row.updatedAt,
        }
      : { ...DEFAULT_INSTRUCTIONS, updatedAt: null };
  }
}
