import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';

export interface ShiftRecord {
  id: string;
  gateId: string;
  gateName: string;
  startedAt: Date;
  endedAt: Date | null;
}

/** The caller's open shift: where and under which shift an action happens. */
export interface OpenShift {
  id: string;
  gateId: string;
  gateName: string;
}

export const SHIFT_RESOURCE = 'guard_shift';

const noOpenShift = () =>
  appError.forbidden(
    ErrorCode.NO_OPEN_SHIFT,
    'Start a shift at a gate before acting at the gate',
  );

/**
 * Guard shifts (ADR 0028). A guard acts at the gate only inside an open
 * shift, which says at which gate; one open shift per guard (a partial
 * unique index backs the check). A guard who leaves the compound's service
 * (deactivated, frozen, erased) has their shift ended in the same
 * transaction.
 */
@Injectable()
export class ShiftsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(SHIFT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.record(tx, id)),
    );
    const endOwn = async (
      tx: TenantTxClient,
      account: { id: string },
      reason: string,
    ) => {
      const open = await tx.guardShift.findFirst({
        where: { guardAccountId: account.id, endedAt: null },
      });
      if (open) await this.close(tx, open.id, reason);
    };
    this.lifecycle.onDeactivated(async (tx, account) => {
      await endOwn(tx, account, 'account_deactivated');
      return [];
    });
    this.lifecycle.onFrozen((tx, account) =>
      endOwn(tx, account, 'account_frozen'),
    );
    this.lifecycle.onErasing(async (tx, account) => {
      await endOwn(tx, account, 'account_erased');
      return [];
    });
  }

  /** The caller's open shift, or 403 NO_OPEN_SHIFT. */
  async requireOpen(tx: TenantTxClient): Promise<OpenShift> {
    const shift = await tx.guardShift.findFirst({
      where: { guardAccountId: this.ctx.accountId, endedAt: null },
      include: { gate: { select: { name: true } } },
    });
    if (!shift) throw noOpenShift();
    return { id: shift.id, gateId: shift.gateId, gateName: shift.gate.name };
  }

  current(): Promise<ShiftRecord> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.record(tx, (await this.requireOpen(tx)).id),
    );
  }

  /** `Idempotency-Key`: a retry replays the same shift. */
  start(gateId: string): Promise<ShiftRecord> {
    const guardAccountId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const gate = await tx.gate.findUnique({ where: { id: gateId } });
      if (!gate || gate.status !== 'active')
        throw appError.notFound(ErrorCode.GATE_NOT_FOUND, 'Gate not found');
      if (
        await tx.guardShift.count({ where: { guardAccountId, endedAt: null } })
      )
        throw shiftAlreadyOpen();
      const id = newId();
      await this.idempotency.claim(tx, { type: SHIFT_RESOURCE, id });
      try {
        await tx.guardShift.create({
          data: { id, tenantId, guardAccountId, gateId },
        });
      } catch (error) {
        // A concurrent start without a key: the partial unique index.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw shiftAlreadyOpen();
        throw error;
      }
      await this.audit.record(tx, {
        action: 'gate.shift_started',
        targetId: id,
        metadata: { gateId },
      });
      return this.record(tx, id);
    });
  }

  /** `Idempotency-Key`: a retry replays the ended shift. */
  end(): Promise<ShiftRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const open = await this.requireOpen(tx);
      await this.idempotency.claim(tx, { type: SHIFT_RESOURCE, id: open.id });
      await this.close(tx, open.id, 'guard');
      return this.record(tx, open.id);
    });
  }

  /** A gate deactivated: its open shifts end with it. */
  async endAllAt(
    tx: TenantTxClient,
    gateId: string,
    reason: string,
  ): Promise<number> {
    const open = await tx.guardShift.findMany({
      where: { gateId, endedAt: null },
      select: { id: true },
    });
    for (const s of open) await this.close(tx, s.id, reason);
    return open.length;
  }

  private async close(
    tx: TenantTxClient,
    shiftId: string,
    reason: string,
  ): Promise<void> {
    const { count } = await tx.guardShift.updateMany({
      where: { id: shiftId, endedAt: null },
      data: { endedAt: new Date(), endReason: reason },
    });
    if (!count) return;
    await this.audit.record(tx, {
      action: 'gate.shift_ended',
      targetId: shiftId,
      metadata: { reason },
    });
  }

  private async record(tx: TenantTxClient, id: string): Promise<ShiftRecord> {
    const s = await tx.guardShift.findUniqueOrThrow({
      where: { id },
      include: { gate: { select: { name: true } } },
    });
    return {
      id: s.id,
      gateId: s.gateId,
      gateName: s.gate.name,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    };
  }
}

function shiftAlreadyOpen() {
  return appError.conflict(
    ErrorCode.SHIFT_ALREADY_OPEN,
    'End the open shift before starting another',
  );
}
