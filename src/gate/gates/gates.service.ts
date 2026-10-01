import { Injectable } from '@nestjs/common';
import type { Gate, GateKind, GateStatus } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { ShiftsService } from '../shifts/shifts.service';

export interface GateInput {
  name: string;
  kind: GateKind;
}

export const gateNotFound = () =>
  appError.notFound(ErrorCode.GATE_NOT_FOUND, 'Gate not found');

/**
 * The compound's gates (ADR 0028), managed with `gate.manage`. A gate is
 * never deleted: entries point at it. Deactivating one ends the shifts open
 * there, so no guard keeps recording at a closed gate.
 */
@Injectable()
export class GatesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
  ) {}

  /** Every gate, by name (a compound has a handful). */
  list(): Promise<Gate[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.gate.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    );
  }

  /** Where a guard may start a shift. */
  active(): Promise<Gate[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.gate.findMany({
        where: { status: 'active' },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  create(input: GateInput): Promise<Gate> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const gate = await tx.gate.create({
        data: {
          id: newId(),
          tenantId,
          name: input.name.trim(),
          kind: input.kind,
        },
      });
      await this.audit.record(tx, {
        action: 'gate.created',
        targetId: gate.id,
        changes: diffChanges(
          null,
          { name: gate.name, kind: gate.kind, status: gate.status },
          'gate.created',
        ),
      });
      return gate;
    });
  }

  update(
    id: string,
    input: { name?: string; kind?: GateKind; status?: GateStatus },
  ): Promise<Gate> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.gate.findUnique({ where: { id } });
      if (!before) throw gateNotFound();
      const gate = await tx.gate.update({
        where: { id },
        data: {
          name: input.name?.trim(),
          kind: input.kind,
          status: input.status,
        },
      });
      const changes = diffChanges(
        { name: before.name, kind: before.kind, status: before.status },
        { name: gate.name, kind: gate.kind, status: gate.status },
        'gate.updated',
      );
      if (!Object.keys(changes).length) return gate;
      await this.audit.record(tx, {
        action: 'gate.updated',
        targetId: gate.id,
        changes,
      });
      if (before.status === 'active' && gate.status === 'inactive') {
        await this.shifts.endAllAt(tx, gate.id, 'gate_deactivated');
      }
      return gate;
    });
  }
}
