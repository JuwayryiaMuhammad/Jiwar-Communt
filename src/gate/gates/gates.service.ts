import { Injectable } from '@nestjs/common';
import type { Gate, GateKind, GateStatus } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { normalizePhone } from '../../core/auth/identifier';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { ShiftsService } from '../shifts/shifts.service';

export interface GateInput {
  name: string;
  kind: GateKind;
  phone?: string;
}

/** E.164, `null` clears, absent keeps (ADR 0043). */
function checkPhone(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const phone = normalizePhone(raw);
  if (!phone)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid phone', {
      fields: [{ field: 'phone', code: FieldErrorCode.INVALID_PHONE }],
    });
  return phone;
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

  /**
   * What an occupant sees of the gates: which exist and whether each is in
   * service. For resident and family accounts only, by kind and with no
   * permission: nothing here is a manager's to grant or withdraw. Never who
   * is on duty: a shift is not read.
   */
  statuses(): Promise<Pick<Gate, 'id' | 'name' | 'status' | 'phone'>[]> {
    const type = this.ctx.accountType;
    if (type !== 'resident' && type !== 'family')
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Only residents and their family see the gate status',
      );
    return this.tenantTx.withTenantTx((tx) =>
      tx.gate.findMany({
        select: { id: true, name: true, status: true, phone: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  create(input: GateInput): Promise<Gate> {
    const tenantId = this.ctx.tenantId;
    const phone = checkPhone(input.phone) ?? null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const gate = await tx.gate.create({
        data: {
          id: newId(),
          tenantId,
          name: input.name.trim(),
          kind: input.kind,
          phone,
        },
      });
      await this.audit.record(tx, {
        action: 'gate.created',
        targetId: gate.id,
        changes: diffChanges(
          null,
          {
            name: gate.name,
            kind: gate.kind,
            status: gate.status,
            ...(gate.phone ? { phone: gate.phone } : {}),
          },
          'gate.created',
        ),
      });
      return gate;
    });
  }

  update(
    id: string,
    input: {
      name?: string;
      kind?: GateKind;
      status?: GateStatus;
      phone?: string | null;
    },
  ): Promise<Gate> {
    const phone = checkPhone(input.phone);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.gate.findUnique({ where: { id } });
      if (!before) throw gateNotFound();
      const gate = await tx.gate.update({
        where: { id },
        data: {
          name: input.name?.trim(),
          kind: input.kind,
          status: input.status,
          phone,
        },
      });
      // The phone is recorded as `{ changed: true }` (a personal-looking
      // value, ADR 0014), like every phone.
      const changes = diffChanges(
        {
          name: before.name,
          kind: before.kind,
          status: before.status,
          phone: before.phone,
        },
        {
          name: gate.name,
          kind: gate.kind,
          status: gate.status,
          phone: gate.phone,
        },
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
