import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { OwnershipTransfer } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  requireReasonCodeOnly,
  type ReasonInput,
} from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  runAfterCommit,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { UnitDues } from '../../core/unit-dues/unit-dues';
import { dbNow } from '../db-clock';
import { ResidentsService } from '../residents/residents.service';
import { lockUnits } from '../units/unit-lock';
import { TransferDuesGate } from './dues-gate';
import {
  transferReference,
  type TransferRead,
  type TransferStatus,
} from './transfer-rules';
import { OwnershipTransferView } from './views/ownership-transfer.views';

export const TRANSFER_RESOURCE = 'ownership_transfer';

const PAGE = keysetCursor('requestedAt');

export const transferNotFound = () =>
  appError.notFound(
    ErrorCode.OWNERSHIP_TRANSFER_NOT_FOUND,
    'Ownership transfer not found',
  );

const notPending = (status: string) =>
  appError.conflict(
    ErrorCode.OWNERSHIP_TRANSFER_NOT_PENDING,
    'The transfer is done or cancelled already',
    { params: { status } },
  );

/**
 * Ownership transfer requests (ADR 0083), the management's
 * (`residents.manage`). A request names the unit, the buyer (an active
 * resident account) and whether they will live there, with the household's
 * end reason (ADR 0021) the leaving occupants are told; one waits per unit
 * at a time (a partial unique index, under the unit's lock). It waits in
 * the staff inbox until it is approved or cancelled, once.
 *
 * Approving runs the dues gate (TransferDuesGate: blocked while the unit
 * owes, unless an exception's code and a fresh step-up are given) and then
 * the transfer itself — ResidentsService's, the same as the direct route:
 * every occupancy ends `ownership_transferred` and stays in the unit's
 * history (ADR 0072), the household ends, the buyer's occupancy starts.
 *
 * Lock order: the accounts the transfer touches, the unit (both
 * ResidentsService.lockForTransfer), the request's row, finance's lock on
 * the unit (the gate). Two approvals at once: the second waits on the
 * accounts, then finds the request done (OWNERSHIP_TRANSFER_NOT_PENDING).
 */
@Injectable()
export class OwnershipTransfersService implements OnModuleInit {
  private readonly logger = new Logger(OwnershipTransfersService.name);

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly residents: ResidentsService,
    private readonly gate: TransferDuesGate,
    private readonly dues: UnitDues,
    private readonly inbox: StaffInbox,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(TRANSFER_RESOURCE, async (id) =>
      OwnershipTransferView.from(await this.get(id)),
    );
    this.inbox.register({
      type: 'ownership_transfer',
      permission: 'residents.manage',
      dueHours: 72,
      page: async (tx, q) => {
        const rows = await tx.ownershipTransfer.findMany({
          where: {
            AND: [
              { status: 'pending' },
              ...waitingSince('requestedAt', q.requestedBefore),
              ...afterCursor('requestedAt', q.after),
            ],
          },
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            unitId: true,
            requestedAt: true,
          },
        });
        return rows.map((r) => ({
          type: 'ownership_transfer' as const,
          id: r.id,
          number: transferReference(r.number),
          kind: null,
          status: r.status,
          unitId: r.unitId,
          requestedAt: r.requestedAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.ownershipTransfer.count({
          where: {
            AND: [
              { status: 'pending' },
              ...waitingSince('requestedAt', before),
            ],
          },
        }),
    });
  }

  /** `Idempotency-Key`. */
  request(
    unitId: string,
    input: { toAccountId: string; resides?: boolean },
    reasonInput: ReasonInput,
  ): Promise<TransferRead> {
    const reason = requireReasonCode(reasonInput, REASON_CODES.householdEnd);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: TRANSFER_RESOURCE, id });
      // The unit's lock: two requests for one unit, one at a time.
      await lockUnits(tx, [unitId]);
      const unit = await tx.unit.findUnique({
        where: { id: unitId },
        select: { id: true },
      });
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const buyer = await tx.account.findFirst({
        where: { id: input.toAccountId, type: 'resident', status: 'active' },
        select: { id: true },
      });
      if (!buyer)
        throw appError.notFound(
          ErrorCode.ACCOUNT_NOT_FOUND,
          'Resident not found',
        );
      const waiting = await tx.ownershipTransfer.findFirst({
        where: { unitId, status: 'pending' },
        select: { number: true },
      });
      if (waiting)
        throw appError.conflict(
          ErrorCode.OWNERSHIP_TRANSFER_PENDING,
          'The unit has a transfer waiting already',
          { params: { reference: transferReference(waiting.number) } },
        );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        hashtext(${`ownership-transfer-number:${this.ctx.txTenantId}`}), 0)`;
      const last = await tx.ownershipTransfer.findFirst({
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const row = await tx.ownershipTransfer.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number: (last?.number ?? 0) + 1,
          unitId,
          buyerId: buyer.id,
          resides: input.resides ?? true,
          reasonCode: reason.code,
          reasonText: reason.text,
          requestedBy: this.ctx.accountId,
          requestedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'ownership_transfer.requested',
        targetId: id,
        metadata: {
          unitId,
          buyerAccountId: buyer.id,
          resides: row.resides,
          reasonCode: reason.code,
        },
      });
      return (await this.reads(tx, [row]))[0];
    });
  }

  list(q: {
    status?: TransferStatus;
    unitId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<TransferRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.ownershipTransfer.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.unitId ? { unitId: q.unitId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.reads(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<TransferRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.ownershipTransfer.findUnique({ where: { id } });
      if (!row) throw transferNotFound();
      return (await this.reads(tx, [row]))[0];
    });
  }

  /**
   * Approves and carries out the transfer, once. A unit that owes is
   * TRANSFER_DUES_OWED unless `duesExceptionCode` is given with a fresh
   * step-up; the gate reads under finance's lock.
   */
  async approve(id: string, duesExceptionCode?: string): Promise<TransferRead> {
    const exception = this.gate.exceptionCode(duesExceptionCode);
    const after: AfterCommit[] = [];
    const read = await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.ownershipTransfer.findUnique({ where: { id } });
      if (!found) throw transferNotFound();
      if (found.status !== 'pending') throw notPending(found.status);
      await this.residents.lockForTransfer(tx, found.unitId, found.buyerId);
      const row = await this.lockRow(tx, id);
      if (row.status !== 'pending') throw notPending(row.status);
      const gate = await this.gate.pass(tx, row.unitId, exception);
      const { occupancyId } = await this.residents.transferOwnershipLocked(
        tx,
        row.unitId,
        { toAccountId: row.buyerId, resides: row.resides },
        { code: row.reasonCode, text: row.reasonText },
        gate,
        after,
        row.id,
      );
      const done = await tx.ownershipTransfer.update({
        where: { id },
        data: {
          status: 'done',
          decidedBy: this.ctx.accountId,
          decidedAt: await dbNow(tx),
          owedAtApproval: gate.owed,
          duesExceptionCode: gate.exception,
          newOccupancyId: occupancyId,
        },
      });
      await this.audit.record(tx, {
        action: 'ownership_transfer.approved',
        targetId: id,
        metadata: {
          unitId: row.unitId,
          owed: gate.owed,
          ...(gate.exception
            ? { duesExceptionCode: gate.exception, stepUp: true }
            : {}),
          newOccupancyId: occupancyId,
        },
      });
      return (await this.reads(tx, [done]))[0];
    });
    await runAfterCommit(after, this.logger);
    return read;
  }

  /** A waiting transfer called off, with a code. */
  cancel(id: string, reasonCode?: string): Promise<TransferRead> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.ownershipTransferCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.ownershipTransfer.findUnique({
        where: { id },
        select: { unitId: true },
      });
      if (!found) throw transferNotFound();
      const row = await this.lockRow(tx, id);
      if (row.status !== 'pending') throw notPending(row.status);
      const cancelled = await tx.ownershipTransfer.update({
        where: { id },
        data: {
          status: 'cancelled',
          decidedBy: this.ctx.accountId,
          decidedAt: await dbNow(tx),
          cancelReason: code,
        },
      });
      await this.audit.record(tx, {
        action: 'ownership_transfer.cancelled',
        targetId: id,
        metadata: { unitId: row.unitId, reasonCode: code },
      });
      return (await this.reads(tx, [cancelled]))[0];
    });
  }

  // --------------------------------------------------------------------------

  private async lockRow(
    tx: TenantTxClient,
    id: string,
  ): Promise<OwnershipTransfer> {
    await tx.$queryRaw`SELECT id FROM ownership_transfers WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.ownershipTransfer.findUniqueOrThrow({ where: { id } });
  }

  private async reads(
    tx: TenantTxClient,
    rows: OwnershipTransfer[],
  ): Promise<TransferRead[]> {
    if (!rows.length) return [];
    const units = await tx.unit.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.unitId))] } },
      select: { id: true, code: true },
    });
    const buyers = await tx.account.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.buyerId))] } },
      select: { id: true, fullName: true, status: true },
    });
    const pending = rows.filter((r) => r.status === 'pending');
    const owed = await this.dues.owed(
      tx,
      pending.map((r) => r.unitId),
    );
    return rows.map((r) => {
      const buyer = buyers.find((b) => b.id === r.buyerId);
      return {
        transfer: r,
        unitCode: units.find((u) => u.id === r.unitId)?.code ?? '',
        buyerName:
          !buyer || buyer.status === 'erased' ? null : (buyer.fullName ?? null),
        owedNow: r.status === 'pending' ? (owed.get(r.unitId) ?? '0.00') : null,
      };
    });
  }
}
