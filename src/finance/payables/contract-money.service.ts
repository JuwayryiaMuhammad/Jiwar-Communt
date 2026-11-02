import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceContractDisbursement,
  type FinanceVendorGuarantee,
  type FinanceVendorPayout,
} from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import {
  PayablesBridge,
  type PayableContract,
} from '../../core/payables/payables-bridge';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, dbNow, localToday } from '../db-clock';
import { money, show, ZERO } from '../money';
import { CashAccountsService } from '../treasury/cash-accounts.service';
import {
  type DisbursementKind,
  type GuaranteeKind,
  type PayoutMethod,
} from './payable-rules';
import { DisbursementView, GuaranteeView } from './views/payables.views';

export const DISBURSEMENT_RESOURCE = 'finance_contract_disbursement';
export const GUARANTEE_RESOURCE = 'finance_vendor_guarantee';

export interface DisbursementRecord {
  disbursement: FinanceContractDisbursement;
  payout: FinanceVendorPayout | null;
  requestedByMe: boolean;
}

/** A contract's money with its vendor, as payables see it. */
export interface ContractPosition {
  contractId: string;
  vendorId: string;
  retentionPct: string | null;
  advances: { paid: string; setOff: string; open: string; asked: string };
  retention: { held: string; released: string; asked: string; open: string };
  invoices: { approved: string; paid: string };
  disbursements: DisbursementRecord[];
  guarantees: FinanceVendorGuarantee[];
}

const contractNotFound = () =>
  appError.notFound(
    ErrorCode.MAINTENANCE_CONTRACT_NOT_FOUND,
    'Contract not found',
  );
const notFound = () =>
  appError.notFound(
    ErrorCode.DISBURSEMENT_NOT_FOUND,
    'Advance or retention release not found',
  );
const state = (status: string) =>
  appError.conflict(
    ErrorCode.DISBURSEMENT_STATE,
    'Not in a state that allows this',
    { params: { status } },
  );
const guaranteeNotFound = () =>
  appError.notFound(ErrorCode.GUARANTEE_NOT_FOUND, 'Guarantee not found');

/**
 * A contract's money with its vendor (ADR 0089): advances paid ahead and
 * set off against its later invoices, the retention held back of each
 * payout and released at its end, and the guarantees its vendor's bank
 * gives. An advance or a release is asked for by `finance.payables` and
 * approved by a `finance.payables_approve` holder who did not ask for it
 * (a CHECK too); above the manager's limit only on a contract the board
 * signed. Approved, it is paid once (a payout, no expense: an advance is
 * spent by the invoices it is set off against, a retention was spent with
 * its invoice).
 *
 * Locks: the caller → the contract (update, maintenance's: every money
 * row of a contract one at a time) → the request or the guarantee
 * (update) → the threshold's row (shared) → the counters.
 */
@Injectable()
export class ContractMoneyService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: FinanceAccess,
    private readonly bridge: PayablesBridge,
    private readonly matters: BoardMatters,
    private readonly settings: TenantSettingsService,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly cashAccounts: CashAccountsService,
  ) {}

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(DISBURSEMENT_RESOURCE, async (id) =>
      DisbursementView.from(await this.get(id)),
    );
    this.idempotency.renderer(GUARANTEE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        GuaranteeView.from(
          await tx.financeVendorGuarantee.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // Advances and retention releases
  // --------------------------------------------------------------------------

  request(
    contractId: string,
    input: { kind: DisbursementKind; amount: string; note?: string },
  ): Promise<DisbursementRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const c = await this.contract(tx, contractId);
      const amount = money(input.amount);
      const today = await this.today(tx);
      const p = await this.position(tx, c);
      if (input.kind === 'advance') {
        // At most what the contract's value leaves after what was paid,
        // set off or asked for already.
        const max = c.annualValue
          ? money(c.annualValue)
              .sub(p.advancePaid)
              .sub(p.advanceAsked)
              .sub(p.invoicesPaid)
          : ZERO;
        if (c.terminated || amount.gt(max))
          throw appError.conflict(
            ErrorCode.ADVANCE_EXCEEDED,
            'More than the contract’s value leaves for advances',
            { params: { max: show(Prisma.Decimal.max(max, ZERO)) } },
          );
      } else {
        if (!c.terminated && c.endsOn >= today)
          throw appError.conflict(
            ErrorCode.RETENTION_NOT_DUE,
            'The contract runs on: its retention is released at its end',
            { params: { endsOn: c.endsOn } },
          );
        const open = p.retentionHeld
          .sub(p.retentionReleased)
          .sub(p.retentionAsked);
        if (amount.gt(open))
          throw appError.conflict(
            ErrorCode.RETENTION_EXCEEDED,
            'More than the contract holds in retention',
            { params: { held: show(open) } },
          );
      }
      const id = newId();
      await this.idempotency.claim(tx, { type: DISBURSEMENT_RESOURCE, id });
      const number = await takeNumbers(tx, this.ctx.txTenantId, 'disbursement');
      const note = input.note?.trim() || null;
      const d = await tx.financeContractDisbursement.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          kind: input.kind,
          contractId: c.id,
          vendorId: c.vendorId,
          amount: show(amount),
          note,
          requestedById: this.ctx.accountId,
          requestedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'contract_disbursement.requested',
        targetId: id,
        changes: diffChanges(
          null,
          {
            number,
            kind: input.kind,
            contractId: c.id,
            amount: show(amount),
            note,
          },
          'contract_disbursement.requested',
        ),
      });
      const approvers = (
        await this.staff.holding(tx, 'finance.payables_approve')
      ).filter((a) => a.id !== this.ctx.accountId);
      await this.notifier.notify(
        tx,
        approvers.map((a) => a.id),
        {
          kind: 'contract_disbursement.requested',
          params: {
            disbursementRef: formatNumber('disbursement', number),
            disbursementKind: input.kind,
          },
          targetId: id,
        },
      );
      return this.read(tx, d);
    });
  }

  approve(id: string): Promise<DisbursementRecord> {
    return this.decide(id, async (tx, d, c) => {
      if (d.requestedById === this.ctx.accountId)
        throw appError.conflict(
          ErrorCode.PAYABLE_SELF_APPROVAL,
          'You asked for this: someone else approves it',
        );
      const limit = await this.matters.threshold(tx, 'major_contract');
      if (limit !== null && money(d.amount).gt(limit) && !c.approvalRequestId)
        throw appError.conflict(
          ErrorCode.DISBURSEMENT_NEEDS_APPROVAL,
          'Above the manager’s limit: only on a contract the board approved',
          { params: { limit } },
        );
      await tx.financeContractDisbursement.update({
        where: { id },
        data: {
          status: 'approved',
          decidedById: this.ctx.accountId,
          decidedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'contract_disbursement.approved',
        targetId: id,
        metadata: { kind: d.kind, amount: show(d.amount) },
      });
    });
  }

  reject(id: string, reasonCode?: string): Promise<DisbursementRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.disbursementReject,
    );
    return this.decide(id, async (tx) => {
      await tx.financeContractDisbursement.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectReason: reason,
          decidedById: this.ctx.accountId,
          decidedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'contract_disbursement.rejected',
        targetId: id,
        metadata: { reasonCode: reason },
      });
    });
  }

  cancel(id: string, reasonCode?: string): Promise<DisbursementRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.disbursementCancel,
    );
    return this.decide(
      id,
      async (tx, d) => {
        await tx.financeContractDisbursement.update({
          where: { id },
          data: {
            status: 'cancelled',
            cancelReason: reason,
            cancelledById: this.ctx.accountId,
            cancelledAt: await dbNow(tx),
          },
        });
        await this.audit.record(tx, {
          action: 'contract_disbursement.cancelled',
          targetId: id,
          metadata: { reasonCode: reason, from: d.status },
        });
      },
      ['requested', 'approved'],
    );
  }

  /**
   * Paid once, whole, on a day not after today, out of the treasury's
   * account of its method's kind (ADR 0085).
   */
  pay(
    id: string,
    input: {
      paidOn: string;
      method: PayoutMethod;
      reference?: string;
      cashAccountId?: string;
    },
  ): Promise<DisbursementRecord> {
    return this.decide(
      id,
      async (tx, d) => {
        const today = await this.today(tx);
        if (input.paidOn > today)
          throw invalid([
            {
              field: 'paidOn',
              code: FieldErrorCode.DAY_OUT_OF_RANGE,
              params: { max: today },
            },
          ]);
        const net = money(d.amount);
        // The treasury's account: after the rows, before the counter.
        const cashAccountId = await this.cashAccounts.payoutAccount(tx, {
          cashAccountId: input.cashAccountId,
          method: input.method,
          net,
          paidOn: input.paidOn,
        });
        const payoutId = newId();
        const number = await takeNumbers(tx, this.ctx.txTenantId, 'payout');
        const now = await dbNow(tx);
        const reference = input.reference?.trim() || null;
        await tx.financeVendorPayout.create({
          data: {
            id: payoutId,
            tenantId: this.ctx.txTenantId,
            number,
            kind: d.kind,
            disbursementId: d.id,
            contractId: d.contractId,
            vendorId: d.vendorId,
            gross: show(d.amount),
            net: show(d.amount),
            method: input.method,
            reference,
            paidOn: asDate(input.paidOn),
            paidById: this.ctx.accountId,
            cashAccountId,
            createdAt: now,
          },
        });
        if (cashAccountId)
          await this.cashAccounts.payoutMovement(tx, {
            payoutId,
            accountId: cashAccountId,
            net,
            paidOn: input.paidOn,
          });
        await tx.financeContractDisbursement.update({
          where: { id },
          data: { status: 'paid', paidAt: now },
        });
        await this.audit.record(tx, {
          action: 'vendor_payout.recorded',
          targetId: payoutId,
          metadata: {
            number,
            kind: d.kind,
            disbursementId: d.id,
            gross: show(d.amount),
            net: show(d.amount),
            method: input.method,
            cashAccountId,
            paidOn: input.paidOn,
          },
          ...(reference ? { changes: { reference: { changed: true } } } : {}),
        });
      },
      ['approved'],
    );
  }

  get(id: string): Promise<DisbursementRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const d = await tx.financeContractDisbursement.findUnique({
        where: { id },
      });
      if (!d) throw notFound();
      return this.read(tx, d);
    });
  }

  /** Waiting for a decision or a payout, oldest first. */
  pending(): Promise<DisbursementRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeContractDisbursement.findMany({
        where: { status: { in: ['requested', 'approved'] } },
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        take: 200,
      });
      const out: DisbursementRecord[] = [];
      for (const d of rows) out.push(await this.read(tx, d));
      return out;
    });
  }

  /** A contract's advances, retention, invoices and guarantees. */
  contractPosition(contractId: string): Promise<ContractPosition> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const c = await this.contract(tx, contractId);
      const p = await this.position(tx, c);
      const rows = await tx.financeContractDisbursement.findMany({
        where: { contractId },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      const disbursements: DisbursementRecord[] = [];
      for (const d of rows) disbursements.push(await this.read(tx, d));
      return {
        contractId: c.id,
        vendorId: c.vendorId,
        retentionPct: c.retentionPct,
        advances: {
          paid: show(p.advancePaid),
          setOff: show(p.advanceSetOff),
          open: show(p.advancePaid.sub(p.advanceSetOff)),
          asked: show(p.advanceAsked),
        },
        retention: {
          held: show(p.retentionHeld),
          released: show(p.retentionReleased),
          asked: show(p.retentionAsked),
          open: show(
            p.retentionHeld.sub(p.retentionReleased).sub(p.retentionAsked),
          ),
        },
        invoices: {
          approved: show(p.invoicesApproved),
          paid: show(p.invoicesPaid),
        },
        disbursements,
        guarantees: await tx.financeVendorGuarantee.findMany({
          where: { contractId },
          orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }],
        }),
      };
    });
  }

  // --------------------------------------------------------------------------
  // Guarantees
  // --------------------------------------------------------------------------

  recordGuarantee(
    contractId: string,
    input: {
      kind: GuaranteeKind;
      issuer: string;
      reference: string;
      amount: string;
      issuedOn: string;
      expiresOn: string;
    },
  ): Promise<FinanceVendorGuarantee> {
    if (input.expiresOn < input.issuedOn)
      throw invalid([
        { field: 'expiresOn', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const c = await this.contract(tx, contractId);
      const id = newId();
      await this.idempotency.claim(tx, { type: GUARANTEE_RESOURCE, id });
      const g = await tx.financeVendorGuarantee.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          contractId: c.id,
          vendorId: c.vendorId,
          kind: input.kind,
          issuer: input.issuer.trim(),
          reference: input.reference.trim(),
          amount: show(input.amount),
          issuedOn: asDate(input.issuedOn),
          expiresOn: asDate(input.expiresOn),
          recordedById: this.ctx.accountId,
          recordedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'vendor_guarantee.recorded',
        targetId: id,
        changes: diffChanges(
          null,
          {
            contractId: c.id,
            kind: input.kind,
            issuer: g.issuer,
            reference: g.reference,
            amount: show(input.amount),
            issuedOn: input.issuedOn,
            expiresOn: input.expiresOn,
          },
          'vendor_guarantee.recorded',
        ),
      });
      return g;
    });
  }

  /** Given back to the vendor, or called on the bank, once. */
  closeGuarantee(
    id: string,
    to: 'returned' | 'called',
  ): Promise<FinanceVendorGuarantee> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`
        SELECT id FROM finance_vendor_guarantees WHERE id = ${id}::uuid FOR UPDATE`;
      const g = await tx.financeVendorGuarantee.findUnique({ where: { id } });
      if (!g) throw guaranteeNotFound();
      if (g.status !== 'held')
        throw appError.conflict(
          ErrorCode.GUARANTEE_STATE,
          'Returned or called already',
          { params: { status: g.status } },
        );
      const done = await tx.financeVendorGuarantee.update({
        where: { id },
        data: {
          status: to,
          closedById: this.ctx.accountId,
          closedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action:
          to === 'returned'
            ? 'vendor_guarantee.returned'
            : 'vendor_guarantee.called',
        targetId: id,
        metadata: { contractId: g.contractId, amount: show(g.amount) },
      });
      return done;
    });
  }

  // --------------------------------------------------------------------------

  /**
   * Under the contract's lock: the request, then its decision. `from` are
   * the statuses the step starts from.
   */
  private decide(
    id: string,
    step: (
      tx: TenantTxClient,
      d: FinanceContractDisbursement,
      c: PayableContract,
    ) => Promise<void>,
    from: string[] = ['requested'],
  ): Promise<DisbursementRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.financeContractDisbursement.findUnique({
        where: { id },
      });
      if (!seen) throw notFound();
      const c = await this.contract(tx, seen.contractId);
      await tx.$queryRaw`
        SELECT id FROM finance_contract_disbursements WHERE id = ${id}::uuid FOR UPDATE`;
      const d = await tx.financeContractDisbursement.findUniqueOrThrow({
        where: { id },
      });
      if (!from.includes(d.status)) throw state(d.status);
      await step(tx, d, c);
      return this.read(
        tx,
        await tx.financeContractDisbursement.findUniqueOrThrow({
          where: { id },
        }),
      );
    });
  }

  private async contract(
    tx: TenantTxClient,
    id: string,
  ): Promise<PayableContract> {
    const c = await this.bridge.source.contract(tx, id);
    if (!c) throw contractNotFound();
    return c;
  }

  private async today(tx: TenantTxClient): Promise<string> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    return localToday(tx, timezone);
  }

  private async position(tx: TenantTxClient, c: PayableContract) {
    const [row] = await tx.$queryRaw<
      Record<
        | 'advance_paid'
        | 'advance_set_off'
        | 'advance_asked'
        | 'retention_held'
        | 'retention_released'
        | 'retention_asked'
        | 'invoices_approved'
        | 'invoices_paid',
        Prisma.Decimal | null
      >[]
    >`
      SELECT
        (SELECT sum(net) FROM finance_vendor_payouts
          WHERE contract_id = ${c.id}::uuid AND kind = 'advance') AS advance_paid,
        (SELECT sum(advance_set_off) FROM finance_vendor_payouts
          WHERE contract_id = ${c.id}::uuid AND kind = 'invoice') AS advance_set_off,
        (SELECT sum(amount) FROM finance_contract_disbursements
          WHERE contract_id = ${c.id}::uuid AND kind = 'advance'
            AND status IN ('requested', 'approved')) AS advance_asked,
        (SELECT sum(retention_held) FROM finance_vendor_payouts
          WHERE contract_id = ${c.id}::uuid AND kind = 'invoice') AS retention_held,
        (SELECT sum(gross) FROM finance_vendor_payouts
          WHERE contract_id = ${c.id}::uuid AND kind = 'retention_release') AS retention_released,
        (SELECT sum(amount) FROM finance_contract_disbursements
          WHERE contract_id = ${c.id}::uuid AND kind = 'retention_release'
            AND status IN ('requested', 'approved')) AS retention_asked,
        (SELECT sum(total) FROM finance_vendor_invoices
          WHERE contract_id = ${c.id}::uuid AND status = 'approved') AS invoices_approved,
        (SELECT sum(total) FROM finance_vendor_invoices
          WHERE contract_id = ${c.id}::uuid AND status = 'paid') AS invoices_paid`;
    const m = (v: Prisma.Decimal | null) => money(v ?? 0);
    return {
      advancePaid: m(row.advance_paid),
      advanceSetOff: m(row.advance_set_off),
      advanceAsked: m(row.advance_asked),
      retentionHeld: m(row.retention_held),
      retentionReleased: m(row.retention_released),
      retentionAsked: m(row.retention_asked),
      invoicesApproved: m(row.invoices_approved),
      invoicesPaid: m(row.invoices_paid),
    };
  }

  private async read(
    tx: TenantTxClient,
    d: FinanceContractDisbursement,
  ): Promise<DisbursementRecord> {
    return {
      disbursement: d,
      payout: await tx.financeVendorPayout.findFirst({
        where: { disbursementId: d.id },
      }),
      requestedByMe: d.requestedById === this.ctx.accountId,
    };
  }
}
