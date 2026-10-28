import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceDeposit,
  type FinanceDepositEvent,
} from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { StepUpService } from '../../core/auth/step-up.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, dbNow, fromDate, localToday } from '../db-clock';
import { money, MONEY, show, ZERO } from '../money';
import { PaymentsService } from '../payments/payments.service';
import { WorksCompletions } from '../../core/works/works-completions';

export const DEPOSIT_KINDS = [
  'finishing_works',
  'move',
  'maintenance_fund',
  'other',
] as const;
export const DEPOSIT_METHODS = ['cash', 'bank_transfer', 'cheque'] as const;
export const REFUND_CHANNELS = ['cash', 'bank_transfer'] as const;

export interface DepositRead {
  id: string;
  number: string;
  unitId: string;
  occupancyId: string;
  kind: string;
  amount: string;
  /** What the management still holds: received less refunded, deducted, forfeited. */
  held: string;
  receivedOn: string;
  method: string;
  refundRequested: boolean;
  events: {
    kind: string;
    amount: string | null;
    reasonCode: string | null;
    at: Date;
  }[];
  /**
   * A finishing-works deposit (ADR 0063): the works found complete since it
   * was received — when, and the certificate's number — or null until then;
   * null for the other kinds. The refund stays the manager's decision.
   */
  worksCompletion: { at: Date; reference: string } | null;
}

export interface NewDeposit {
  occupancyId: string;
  kind: string;
  amount: string;
  receivedOn: string;
  method: string;
  reference?: string;
}

export interface Settlement {
  refund?: { amount: string; channel: string };
  deductions?: { reasonCode: string; amount: string }[];
  forfeit?: { reasonCode: string; amount: string };
}

const notFound = () =>
  appError.notFound(ErrorCode.DEPOSIT_NOT_FOUND, 'Deposit not found');
const MONEY_EVENTS = ['refunded', 'deducted', 'forfeited'];

/**
 * Deposits the management holds (ADR 0062): a finishing-works or a move
 * deposit, the maintenance fund. A lease's deposit between an owner and a
 * tenant is theirs, not here. `deposits.manage` records one, once; its
 * depositor (the occupancy's account, never a delegate) asks for a refund
 * and may withdraw the ask; a manager with `finance.refund` and a fresh
 * step-up settles it: a refund (cash or transfer), deductions with codes, a
 * forfeit. A deduction for unpaid dues becomes an office payment of method
 * `deposit_offset`, allocated as any payment, so the unit can then be
 * cleared. Everything is an append-only event; what is held is computed.
 * Its release is its own refund ask, not a ResidentItems hold.
 *
 * Lock order: the caller's account (FOR SHARE), the unit's finance lock,
 * the deposit (FOR UPDATE).
 */
@Injectable()
export class DepositsService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly access: FinanceAccess,
    private readonly community: CommunityFinancePort,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpService,
    private readonly payments: PaymentsService,
    private readonly settings: TenantSettingsService,
    private readonly lifecycle: AccountLifecycle,
    private readonly works: WorksCompletions,
  ) {}

  onModuleInit(): void {
    // Money still held for one of the account's occupancies blocks its erasure.
    this.lifecycle.onDeletionCheck(async (tx, account) => {
      const deposits = await tx.financeDeposit.findMany({
        where: { occupancy: { accountId: account.id } },
        include: { events: true },
      });
      return deposits.some((d) => heldOf(d).gt(ZERO)) ? ['deposit_held'] : [];
    });
  }

  // --------------------------------------------------------------------------
  // The depositor's side
  // --------------------------------------------------------------------------

  mine(): Promise<DepositRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeDeposit.findMany({
        where: { occupancy: { accountId: this.ctx.accountId } },
        include: { events: { orderBy: { at: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      // One query at a time on the transaction's connection.
      const out: DepositRead[] = [];
      for (const d of rows) out.push(await this.full(tx, d));
      return out;
    });
  }

  /** The depositor asks for its refund; one open ask, something held. */
  async askRefund(id: string): Promise<DepositRead> {
    return this.write(id, true, async (tx, d) => {
      if (refundAsked(d))
        throw appError.conflict(
          ErrorCode.DEPOSIT_REFUND_ASKED,
          'A refund is asked already',
        );
      if (!heldOf(d).gt(ZERO))
        throw appError.conflict(
          ErrorCode.DEPOSIT_NOTHING_HELD,
          'Nothing is held',
        );
      await this.event(tx, d, { kind: 'refund_requested' });
      await this.audit.record(tx, {
        action: 'deposit.refund_requested',
        targetId: d.id,
        metadata: { unitId: d.unitId },
      });
    });
  }

  async withdrawRefund(id: string): Promise<DepositRead> {
    return this.write(id, true, async (tx, d) => {
      if (!refundAsked(d))
        throw appError.conflict(
          ErrorCode.DEPOSIT_REFUND_NOT_ASKED,
          'No refund is asked',
        );
      await this.event(tx, d, { kind: 'refund_withdrawn' });
      await this.audit.record(tx, {
        action: 'deposit.refund_withdrawn',
        targetId: d.id,
        metadata: { unitId: d.unitId },
      });
    });
  }

  // --------------------------------------------------------------------------
  // The management's side
  // --------------------------------------------------------------------------

  staffList(unitId: string): Promise<DepositRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await this.community.units(tx, [unitId])).has(unitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const rows = await tx.financeDeposit.findMany({
        where: { unitId },
        include: { events: { orderBy: { at: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      // One query at a time on the transaction's connection.
      const out: DepositRead[] = [];
      for (const d of rows) out.push(await this.full(tx, d));
      return out;
    });
  }

  /** `deposits.manage` records money received for an occupancy. */
  async record(input: NewDeposit): Promise<DepositRead> {
    const fields: FieldError[] = [];
    if (!MONEY.test(input.amount ?? ''))
      fields.push({ field: 'amount', code: FieldErrorCode.INVALID_NUMBER });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid deposit',
        {
          fields,
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const occupancy = await this.community.occupancy(tx, input.occupancyId);
      if (!occupancy || occupancy.status !== 'active')
        throw appError.notFound(
          ErrorCode.OCCUPANCY_NOT_FOUND,
          'Occupancy not found',
        );
      await this.access.lockUnits(tx, [occupancy.unitId]);
      const number = await takeNumbers(tx, this.ctx.txTenantId, 'deposit');
      const d = await tx.financeDeposit.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          number,
          unitId: occupancy.unitId,
          occupancyId: input.occupancyId,
          kind: input.kind,
          amount: money(input.amount),
          receivedOn: asDate(input.receivedOn),
          method: input.method,
          reference: input.reference ?? null,
          recordedBy: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
        include: { events: true },
      });
      await this.audit.record(tx, {
        action: 'deposit.recorded',
        targetId: d.id,
        metadata: {
          unitId: d.unitId,
          kind: d.kind,
          amount: show(d.amount),
          number: formatNumber('deposit', number),
        },
      });
      return this.full(tx, d);
    });
  }

  /**
   * Settles what is held, in part or whole (`finance.refund`, step-up):
   * never more than is held.
   */
  async settle(id: string, s: Settlement): Promise<DepositRead> {
    const parts = validateSettlement(s);
    return this.write(id, false, async (tx, d) => {
      await this.stepUp.consume(tx);
      const total = parts.reduce((sum, p) => sum.add(p.amount), ZERO);
      if (total.gt(heldOf(d)))
        throw appError.conflict(
          ErrorCode.DEPOSIT_EXCEEDS_HELD,
          'More than is held',
          { params: { held: show(heldOf(d)) } },
        );
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = await localToday(tx, timezone);
      for (const p of parts) {
        let paymentId: string | null = null;
        if (p.kind === 'deducted' && p.reasonCode === 'unpaid_dues') {
          paymentId = newId();
          await this.payments.create(tx, paymentId, {
            unitId: d.unitId,
            channel: 'office',
            method: 'deposit_offset',
            amount: p.amount,
            paidOn: today,
            reference: formatNumber('deposit', d.number),
            recordedById: this.ctx.accountId,
            named: [],
          });
        }
        await this.event(tx, d, { ...p, paymentId });
      }
      await this.audit.record(tx, {
        action: 'deposit.settled',
        targetId: d.id,
        metadata: {
          unitId: d.unitId,
          parts: parts.map((p) => ({
            kind: p.kind,
            amount: show(p.amount),
            ...(p.reasonCode ? { reasonCode: p.reasonCode } : {}),
          })),
        },
      });
    });
  }

  // --------------------------------------------------------------------------

  private write(
    id: string,
    depositor: boolean,
    fn: (
      tx: TenantTxClient,
      d: FinanceDeposit & { events: FinanceDepositEvent[] },
    ) => Promise<void>,
  ): Promise<DepositRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await tx.financeDeposit.findFirst({
        where: {
          id,
          ...(depositor
            ? { occupancy: { accountId: this.ctx.accountId } }
            : {}),
        },
        select: { unitId: true },
      });
      if (!found) throw notFound();
      await this.access.lockUnits(tx, [found.unitId]);
      await tx.$queryRaw`SELECT id FROM finance_deposits WHERE id = ${id}::uuid FOR UPDATE`;
      const load = () =>
        tx.financeDeposit.findUniqueOrThrow({
          where: { id },
          include: { events: { orderBy: { at: 'asc' } } },
        });
      await fn(tx, await load());
      return this.full(tx, await load());
    });
  }

  private async event(
    tx: TenantTxClient,
    d: FinanceDeposit,
    e: {
      kind: string;
      amount?: Prisma.Decimal;
      reasonCode?: string | null;
      channel?: string | null;
      paymentId?: string | null;
    },
  ) {
    await tx.financeDepositEvent.create({
      data: {
        id: newId(),
        tenantId: d.tenantId,
        depositId: d.id,
        kind: e.kind,
        amount: e.amount ?? null,
        reasonCode: e.reasonCode ?? null,
        channel: e.channel ?? null,
        paymentId: e.paymentId ?? null,
        byAccount: this.ctx.accountId,
        at: await dbNow(tx),
      },
    });
  }

  /** The view, with a finishing-works deposit's completion (ADR 0063). */
  private async full(
    tx: TenantTxClient,
    d: FinanceDeposit & { events: FinanceDepositEvent[] },
  ): Promise<DepositRead> {
    return {
      ...read(d),
      worksCompletion:
        d.kind === 'finishing_works'
          ? await this.works.read(tx, { unitId: d.unitId, since: d.receivedOn })
          : null,
    };
  }
}

export function heldOf(d: FinanceDeposit & { events: FinanceDepositEvent[] }) {
  return d.events
    .filter((e) => MONEY_EVENTS.includes(e.kind))
    .reduce((left, e) => left.sub(e.amount!), money(d.amount));
}

/** An ask stands until it is withdrawn or anything is settled after it. */
function refundAsked(d: { events: FinanceDepositEvent[] }): boolean {
  let asked = false;
  for (const e of [...d.events].sort((a, b) => a.at.getTime() - b.at.getTime()))
    asked = e.kind === 'refund_requested' ? true : false;
  return asked;
}

function read(
  d: FinanceDeposit & { events: FinanceDepositEvent[] },
): Omit<DepositRead, 'worksCompletion'> {
  return {
    id: d.id,
    number: formatNumber('deposit', d.number),
    unitId: d.unitId,
    occupancyId: d.occupancyId,
    kind: d.kind,
    amount: show(d.amount),
    held: show(heldOf(d)),
    receivedOn: fromDate(d.receivedOn),
    method: d.method,
    refundRequested: refundAsked(d),
    events: d.events.map((e) => ({
      kind: e.kind,
      amount: e.amount ? show(e.amount) : null,
      reasonCode: e.reasonCode,
      at: e.at,
    })),
  };
}

interface Part {
  kind: 'refunded' | 'deducted' | 'forfeited';
  amount: Prisma.Decimal;
  reasonCode: string | null;
  channel: string | null;
}

function validateSettlement(s: Settlement): Part[] {
  const fields: FieldError[] = [];
  const parts: Part[] = [];
  const amount = (field: string, v: string) => {
    if (!MONEY.test(v ?? '')) {
      fields.push({ field, code: FieldErrorCode.INVALID_NUMBER });
      return ZERO;
    }
    return money(v);
  };
  const codes: readonly string[] = REASON_CODES.depositDeduction;
  if (s.refund)
    parts.push({
      kind: 'refunded',
      amount: amount('refund.amount', s.refund.amount),
      reasonCode: null,
      channel: s.refund.channel,
    });
  for (const [i, d] of (s.deductions ?? []).entries()) {
    if (!codes.includes(d.reasonCode))
      fields.push({
        field: `deductions.${i}.reasonCode`,
        code: FieldErrorCode.INVALID_VALUE,
        params: { allowed: [...codes] },
      });
    parts.push({
      kind: 'deducted',
      amount: amount(`deductions.${i}.amount`, d.amount),
      reasonCode: d.reasonCode,
      channel: null,
    });
  }
  if (s.forfeit) {
    if (
      !codes.includes(s.forfeit.reasonCode) ||
      s.forfeit.reasonCode === 'unpaid_dues'
    )
      fields.push({
        field: 'forfeit.reasonCode',
        code: FieldErrorCode.INVALID_VALUE,
      });
    parts.push({
      kind: 'forfeited',
      amount: amount('forfeit.amount', s.forfeit.amount),
      reasonCode: s.forfeit.reasonCode,
      channel: null,
    });
  }
  if (!parts.length)
    fields.push({ field: 'refund', code: FieldErrorCode.FIELD_REQUIRED });
  if (fields.length)
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Invalid settlement',
      {
        fields,
      },
    );
  return parts;
}
