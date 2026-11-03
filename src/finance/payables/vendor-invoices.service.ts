import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceVendorInvoice,
  type FinanceVendorInvoiceLine,
  type FinanceVendorPayout,
} from '@prisma/client';
import { PermissionsService } from '../../core/access/permissions.service';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import {
  PayablesBridge,
  type PayableContract,
} from '../../core/payables/payables-bridge';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { VendorDirectory } from '../../core/vendors/vendor-directory';
import { FinanceAccess } from '../access';
import { BudgetsService, budgetLineNotFound } from '../budgets/budgets.service';
import { ExpensesService } from '../budgets/expenses.service';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, dbNow, localToday } from '../db-clock';
import { money, show, ZERO } from '../money';
import {
  CommitmentsService,
  lineInsufficient,
  lockLines,
} from './commitments.service';
import {
  lineTax,
  LIVE_INVOICE,
  retentionOf,
  type InvoiceStatus,
  type PayoutMethod,
  type TaxCode,
} from './payable-rules';
import { VendorInvoiceView } from './views/payables.views';

export const VENDOR_INVOICE_RESOURCE = 'finance_vendor_invoice';
export const VENDOR_PAYOUT_RESOURCE = 'finance_vendor_payout';
const PAGE = keysetCursor('recordedAt', 'desc');
const MAX_TOTAL = new Prisma.Decimal('999999999.99');

export interface NewVendorInvoice {
  vendorId?: string;
  vendorNumber: string;
  issuedOn: string;
  dueOn: string;
  contractId?: string;
  contractPaymentId?: string;
  purchaseRequestId?: string;
  budgetLineId?: string;
  invoiceFileId: string;
  lines: { description: string; amount: string; taxCode?: TaxCode }[];
  note?: string;
}

/**
 * Who sent the invoice in (ADR 0088): the office (`finance.payables`), or a
 * vendor's contractor for its own vendor (`vendor_invoices.submit`).
 */
export type InvoiceChannel =
  { kind: 'office' } | { kind: 'contractor'; vendorId: string };

export interface InvoiceRecord {
  invoice: FinanceVendorInvoice;
  lines: FinanceVendorInvoiceLine[];
  payout: FinanceVendorPayout | null;
  invoiceUrl: string | null;
  recordedByMe: boolean;
}

export const invoiceNotFound = () =>
  appError.notFound(
    ErrorCode.VENDOR_INVOICE_NOT_FOUND,
    'Vendor invoice not found',
  );
const invoiceState = (status: string) =>
  appError.conflict(
    ErrorCode.VENDOR_INVOICE_STATE,
    'The invoice is not in a state that allows this',
    { params: { status } },
  );
const sourceInvalid = (
  reason:
    | 'vendor_mismatch'
    | 'not_fulfilled'
    | 'paid'
    | 'invoiced'
    | 'not_its_contract',
) =>
  appError.conflict(
    ErrorCode.VENDOR_INVOICE_SOURCE_INVALID,
    'What this invoice is against cannot take it',
    { params: { reason } },
  );
const selfApproval = () =>
  appError.conflict(
    ErrorCode.PAYABLE_SELF_APPROVAL,
    'You recorded this: someone else approves it',
  );

/**
 * Vendors' invoices (ADR 0089): what a vendor of the register bills the
 * compound, against one of its contracts, a line of the contract's payment
 * schedule, or a purchase request it fulfilled (maintenance's, read through
 * core's PayablesBridge). Received by `finance.payables`; approved by a
 * `finance.payables_approve` holder who did not record it, against a line
 * of the active budget: its commitment is released, and the line must
 * have the rest available. Above the manager's limit (major_contract's
 * threshold) it needs the board's approved major contract — the one its
 * contract or purchase was signed under, or one named — spent down as an
 * expense would (ADR 0055; one path, the same authorization). Approved, it
 * is paid once: the payout writes its expense, holds back the contract's
 * retention and sets off its open advances.
 *
 * Locks: the caller → the contract, then its payment or the purchase
 * request (update, maintenance's) → the vendor (shared) → the vendor's
 * number (advisory) → the invoice (update) → the lines' budgets (shared)
 * and lines (update, in id order) → the threshold's row (shared) → the
 * authorization (update) → the counters (expense, vendor_invoice, payout).
 */
@Injectable()
export class VendorInvoicesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: FinanceAccess,
    private readonly permissions: PermissionsService,
    private readonly bridge: PayablesBridge,
    private readonly vendors: VendorDirectory,
    private readonly budgets: BudgetsService,
    private readonly expenses: ExpensesService,
    private readonly commitments: CommitmentsService,
    private readonly matters: BoardMatters,
    private readonly settings: TenantSettingsService,
    private readonly files: FilesService,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(VENDOR_INVOICE_RESOURCE, async (id) =>
      VendorInvoiceView.from(await this.get(id)),
    );
    this.idempotency.renderer(VENDOR_PAYOUT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const p = await tx.financeVendorPayout.findUniqueOrThrow({
          where: { id },
        });
        return VendorInvoiceView.from(
          await this.load(
            tx,
            await tx.financeVendorInvoice.findUniqueOrThrow({
              where: { id: p.vendorInvoiceId! },
            }),
          ),
        );
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Received
  // --------------------------------------------------------------------------

  /**
   * By the office, or by a vendor's contractor (ADR 0088): the `contractor`
   * channel, against its own vendor's contract or fulfilled purchase only —
   * anyone else's is the same 404 as an unknown one — never naming a vendor
   * or a line itself. Its approval and payout are the office's, unchanged.
   */
  record(
    input: NewVendorInvoice,
    channel: InvoiceChannel = { kind: 'office' },
  ): Promise<InvoiceRecord> {
    const contractor = channel.kind === 'contractor' ? channel : null;
    if (contractor && (input.vendorId || input.budgetLineId))
      throw invalid([
        {
          field: input.vendorId ? 'vendorId' : 'budgetLineId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        },
      ]);
    if (!input.contractId === !input.purchaseRequestId)
      throw invalid([
        {
          field: input.contractId ? 'purchaseRequestId' : 'contractId',
          code: input.contractId
            ? FieldErrorCode.FIELD_NOT_ALLOWED
            : FieldErrorCode.FIELD_REQUIRED,
        },
      ]);
    if (input.contractPaymentId && !input.contractId)
      throw invalid([
        { field: 'contractId', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    if (input.dueOn < input.issuedOn)
      throw invalid([
        { field: 'dueOn', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    const lines = input.lines.map((l, i) => {
      const code = l.taxCode ?? 'zero';
      return {
        position: i + 1,
        description: l.description.trim(),
        amount: show(l.amount),
        taxCode: code,
        tax: lineTax(l.amount, code),
      };
    });
    const subtotal = lines.reduce((a, l) => a.add(l.amount), ZERO);
    const tax = lines.reduce((a, l) => a.add(l.tax), ZERO);
    if (subtotal.add(tax).gt(MAX_TOTAL))
      throw invalid([
        {
          field: 'lines',
          code: FieldErrorCode.INVALID_VALUE,
          params: { max: show(MAX_TOTAL) },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = await localToday(tx, timezone);
      if (input.issuedOn > today)
        throw invalid([
          {
            field: 'issuedOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { max: today },
          },
        ]);
      // What it is against, locked (maintenance's rows), and its vendor.
      let vendorId: string | null = null;
      let lineId: string | null = null;
      let approvalRequestId: string | null = null;
      if (input.contractId) {
        const c = await this.bridge.source.contract(tx, input.contractId);
        if (!c || (contractor && c.vendorId !== contractor.vendorId))
          throw appError.notFound(
            ErrorCode.MAINTENANCE_CONTRACT_NOT_FOUND,
            'Contract not found',
          );
        vendorId = c.vendorId;
        lineId = c.budgetLineId;
        approvalRequestId = c.approvalRequestId;
        if (input.contractPaymentId) {
          const p = await this.bridge.source.payment(
            tx,
            input.contractPaymentId,
          );
          if (!p)
            throw appError.notFound(
              ErrorCode.CONTRACT_PAYMENT_NOT_FOUND,
              'Payment not found',
            );
          if (p.contractId !== c.id) throw sourceInvalid('not_its_contract');
          if (p.paid) throw sourceInvalid('paid');
          if (
            await tx.financeVendorInvoice.findFirst({
              where: {
                contractPaymentId: p.id,
                status: { in: LIVE_INVOICE },
              },
              select: { id: true },
            })
          )
            throw sourceInvalid('invoiced');
        }
      } else {
        const r = await this.bridge.source.purchase(
          tx,
          input.purchaseRequestId!,
        );
        if (!r || (contractor && r.vendorId !== contractor.vendorId))
          throw appError.notFound(
            ErrorCode.PURCHASE_REQUEST_NOT_FOUND,
            'Purchase request not found',
          );
        if (r.status !== 'fulfilled') throw sourceInvalid('not_fulfilled');
        vendorId = r.vendorId;
        lineId = r.budgetLineId;
        approvalRequestId = r.approvalRequestId;
      }
      if (input.vendorId && vendorId && input.vendorId !== vendorId)
        throw sourceInvalid('vendor_mismatch');
      if (!vendorId) {
        // A purchase that named no vendor: the register's, not suspended.
        if (!input.vendorId)
          throw invalid([
            { field: 'vendorId', code: FieldErrorCode.FIELD_REQUIRED },
          ]);
        vendorId = (await this.vendors.forSpend(tx, {
          vendorId: input.vendorId,
        }))!.id;
      }
      const budgetLineId = input.budgetLineId ?? lineId;
      if (
        input.budgetLineId &&
        !(await tx.financeBudgetLine.findUnique({
          where: { id: input.budgetLineId },
        }))
      )
        throw budgetLineNotFound();
      // One live invoice a vendor's number, whatever its case: one writer
      // a number at a time, then the check; the unique index backs it.
      const vendorNumber = input.vendorNumber.trim();
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${`vendor-invoice:${this.ctx.txTenantId}:${vendorId}`}),
          hashtext(${vendorNumber.toLowerCase()}))`;
      const [twin] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM finance_vendor_invoices
         WHERE vendor_id = ${vendorId}::uuid
           AND lower(vendor_number) = ${vendorNumber.toLowerCase()}
           AND status IN ('received', 'approved', 'paid')
         LIMIT 1`;
      if (twin)
        throw appError.conflict(
          ErrorCode.VENDOR_INVOICE_DUPLICATE,
          'This vendor’s invoice number is recorded already',
          { params: { invoiceId: twin.id } },
        );
      // The board's approval its source was signed under, if it granted one.
      const authorizationId = approvalRequestId
        ? ((
            await tx.financeExpenseAuthorization.findFirst({
              where: { approvalRequestId },
              select: { id: true },
            })
          )?.id ?? null)
        : null;
      const id = newId();
      await this.idempotency.claim(tx, { type: VENDOR_INVOICE_RESOURCE, id });
      const file = await this.files.claim(
        tx,
        input.invoiceFileId,
        'expense_invoice',
      );
      if (!file)
        throw invalid([
          { field: 'invoiceFileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      await this.files.attach(tx, file);
      const number = await takeNumbers(
        tx,
        this.ctx.txTenantId,
        'vendor_invoice',
      );
      const now = await dbNow(tx);
      const note = input.note?.trim() || null;
      const invoice = await tx.financeVendorInvoice.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          channel: channel.kind,
          vendorId,
          vendorNumber,
          issuedOn: asDate(input.issuedOn),
          dueOn: asDate(input.dueOn),
          contractId: input.contractId ?? null,
          contractPaymentId: input.contractPaymentId ?? null,
          purchaseRequestId: input.purchaseRequestId ?? null,
          budgetLineId,
          authorizationId,
          invoiceFileId: file.id,
          subtotal: show(subtotal),
          tax: show(tax),
          total: show(subtotal.add(tax)),
          note,
          recordedById: this.ctx.accountId,
          recordedAt: now,
        },
      });
      await tx.financeVendorInvoiceLine.createMany({
        data: lines.map((l) => ({
          tenantId: this.ctx.txTenantId,
          invoiceId: id,
          position: l.position,
          description: l.description,
          amount: l.amount,
          taxCode: l.taxCode,
          taxRate: l.taxCode === 'vat_14' ? 14 : 0,
          tax: l.tax,
        })),
      });
      await this.audit.record(tx, {
        action: 'vendor_invoice.recorded',
        targetId: id,
        changes: diffChanges(
          null,
          {
            number,
            channel: channel.kind,
            vendorId,
            vendorNumber,
            issuedOn: input.issuedOn,
            dueOn: input.dueOn,
            contractId: invoice.contractId,
            contractPaymentId: invoice.contractPaymentId,
            purchaseRequestId: invoice.purchaseRequestId,
            budgetLineId,
            subtotal: show(subtotal),
            tax: show(tax),
            total: show(subtotal.add(tax)),
            lines: lines.length,
            note,
          },
          'vendor_invoice.recorded',
        ),
      });
      const approvers = (
        await this.staff.holding(tx, 'finance.payables_approve')
      ).filter((a) => a.id !== this.ctx.accountId);
      await this.notifier.notify(
        tx,
        approvers.map((a) => a.id),
        {
          kind: 'vendor_invoice.received',
          params: { invoiceRef: formatNumber('vendor_invoice', number) },
          targetId: id,
        },
      );
      return this.load(tx, invoice);
    });
  }

  // --------------------------------------------------------------------------
  // Decided
  // --------------------------------------------------------------------------

  approve(
    id: string,
    input: { budgetLineId?: string; authorizationId?: string },
  ): Promise<InvoiceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.lock(tx, id);
      if (before.status !== 'received') throw invoiceState(before.status);
      // Nobody approves what they recorded, the board's approval or not.
      if (before.recordedById === this.ctx.accountId) throw selfApproval();
      const lineId = input.budgetLineId ?? before.budgetLineId;
      if (!lineId)
        throw invalid([
          { field: 'budgetLineId', code: FieldErrorCode.FIELD_REQUIRED },
        ]);
      const commitment = await this.commitments.openFor(tx, before);
      const lines = await lockLines(tx, this.budgets, [
        lineId,
        ...(commitment ? [commitment.lineId] : []),
      ]);
      const line = lines.get(lineId);
      if (!line) throw budgetLineNotFound();
      const budget = await tx.financeBudget.findUniqueOrThrow({
        where: { id: line.budgetId },
      });
      if (budget.status !== 'active')
        throw appError.conflict(
          ErrorCode.BUDGET_NOT_ACTIVE,
          'The line’s budget is not active',
          { params: { status: budget.status } },
        );
      const now = await dbNow(tx);
      // What was kept for it is given back first: a contract's payment
      // whole (the invoice is that payment's), a purchase up to the total.
      if (commitment) {
        await this.commitments.releaseForInvoice(tx, commitment, before, now);
        if (before.contractPaymentId)
          await this.commitments.closeRest(tx, commitment.id, 'changed', now);
      }
      const total = money(before.total);
      const { available } = await this.budgets.figuresOf(tx, line);
      if (total.gt(available)) throw lineInsufficient(available);
      const limit = await this.matters.threshold(tx, 'major_contract');
      let authorizationId: string | null = null;
      if (limit !== null && total.gt(limit)) {
        const named = input.authorizationId ?? before.authorizationId;
        if (!named)
          throw appError.conflict(
            ErrorCode.EXPENSE_NEEDS_APPROVAL,
            'Above the manager’s limit: the board approves it as a major contract',
            { params: { limit } },
          );
        const auth = await this.expenses.lockAuthorization(tx, named);
        if (total.gt(auth.remaining))
          throw appError.conflict(
            ErrorCode.EXPENSE_AUTHORIZATION_EXCEEDED,
            'More than the approved contract has left',
            { params: { remaining: show(auth.remaining) } },
          );
        authorizationId = auth.authorization.id;
      } else if (input.authorizationId)
        throw invalid([
          { field: 'authorizationId', code: FieldErrorCode.FIELD_NOT_ALLOWED },
        ]);
      const invoice = await tx.financeVendorInvoice.update({
        where: { id },
        data: {
          status: 'approved',
          budgetLineId: lineId,
          authorizationId,
          decidedById: this.ctx.accountId,
          decidedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'vendor_invoice.approved',
        targetId: id,
        metadata: {
          lineId,
          authorizationId,
          total: show(total),
          commitmentId: commitment?.id ?? null,
        },
      });
      await this.tell(tx, before, 'approved');
      return this.load(tx, invoice);
    });
  }

  reject(id: string, input: { reasonCode?: string }): Promise<InvoiceRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.vendorInvoiceReject,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.lock(tx, id);
      if (before.status !== 'received') throw invoiceState(before.status);
      const invoice = await tx.financeVendorInvoice.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectReason: reason,
          decidedById: this.ctx.accountId,
          decidedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'vendor_invoice.rejected',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      await this.tell(tx, before, 'rejected');
      return this.load(tx, invoice);
    });
  }

  /**
   * Called off: a received one by who keeps payables, an approved one only
   * by an approver. What was released of its commitment stays released.
   */
  async cancel(
    id: string,
    input: { reasonCode?: string },
  ): Promise<InvoiceRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.vendorInvoiceCancel,
    );
    const approver = await this.permissions.has('finance.payables_approve');
    const keeper = await this.permissions.has('finance.payables');
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.lock(tx, id);
      const may =
        (before.status === 'received' && (keeper || approver)) ||
        (before.status === 'approved' && approver);
      if (!may) throw invoiceState(before.status);
      const invoice = await tx.financeVendorInvoice.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelReason: reason,
          cancelledById: this.ctx.accountId,
          cancelledAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'vendor_invoice.cancelled',
        targetId: id,
        metadata: { reasonCode: reason, from: before.status },
      });
      return this.load(tx, invoice);
    });
  }

  // --------------------------------------------------------------------------
  // Paid out
  // --------------------------------------------------------------------------

  /**
   * Paid once (an approved invoice): its expense written (ADR 0055) on its
   * line, under its authorization, on the day it was paid; the contract's
   * retention held back and its open advances set off as asked; a schedule
   * payment marked paid with the payout's number. How it was paid is a
   * method and a reference: the treasury's account (ADR 0085) joins it
   * when the two phases meet.
   */
  pay(
    id: string,
    input: {
      paidOn: string;
      method: PayoutMethod;
      reference?: string;
      advanceSetOff?: string;
    },
  ): Promise<InvoiceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.financeVendorInvoice.findUnique({ where: { id } });
      if (!seen) throw invoiceNotFound();
      // Maintenance's rows first: the contract (its money, one payout at a
      // time), then the schedule's payment.
      const contract: PayableContract | null = seen.contractId
        ? await this.bridge.source.contract(tx, seen.contractId)
        : null;
      if (seen.contractPaymentId)
        await this.bridge.source.payment(tx, seen.contractPaymentId);
      const invoice = await this.lock(tx, id);
      if (invoice.status !== 'approved') throw invoiceState(invoice.status);
      const lineId = invoice.budgetLineId!;
      const lines = await lockLines(tx, this.budgets, [lineId]);
      const line = lines.get(lineId)!;
      const budget = await tx.financeBudget.findUniqueOrThrow({
        where: { id: line.budgetId },
      });
      const { from, to, today } = await this.budgets.window(tx, budget);
      const last = to < today ? to : today;
      if (input.paidOn < from || input.paidOn > last)
        throw invalid([
          {
            field: 'paidOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { min: from, max: last },
          },
        ]);
      const gross = money(invoice.total);
      const retention = money(
        retentionOf(gross, contract?.retentionPct ?? null),
      );
      const setOff = money(input.advanceSetOff ?? 0);
      if (setOff.gt(0)) {
        if (!contract)
          throw invalid([
            { field: 'advanceSetOff', code: FieldErrorCode.FIELD_NOT_ALLOWED },
          ]);
        const open = await this.openAdvances(tx, contract.id);
        if (setOff.gt(open))
          throw appError.conflict(
            ErrorCode.ADVANCE_SET_OFF_EXCEEDED,
            'More than the contract’s advances have open',
            { params: { open: show(open) } },
          );
        if (setOff.gt(gross.sub(retention)))
          throw invalid([
            {
              field: 'advanceSetOff',
              code: FieldErrorCode.INVALID_VALUE,
              params: { max: show(gross.sub(retention)) },
            },
          ]);
      }
      const payoutId = newId();
      await this.idempotency.claim(tx, {
        type: VENDOR_PAYOUT_RESOURCE,
        id: payoutId,
      });
      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: invoice.vendorId },
        select: { name: true },
      });
      const expenseNumber = await takeNumbers(
        tx,
        this.ctx.txTenantId,
        'expense',
      );
      const number = await takeNumbers(tx, this.ctx.txTenantId, 'payout');
      const reference = formatNumber('payout', number);
      const now = await dbNow(tx);
      const expenseId = newId();
      await tx.financeExpense.create({
        data: {
          id: expenseId,
          tenantId: this.ctx.txTenantId,
          number: expenseNumber,
          budgetLineId: lineId,
          authorizationId: invoice.authorizationId,
          vendor: vendor.name.slice(0, 200),
          vendorId: invoice.vendorId,
          amount: show(gross),
          spentOn: asDate(input.paidOn),
          invoiceFileId: invoice.invoiceFileId,
          reference,
          recordedById: this.ctx.accountId,
          recordedAt: now,
          vendorInvoiceId: invoice.id,
        },
      });
      await this.audit.record(tx, {
        action: 'expense.recorded',
        targetId: expenseId,
        changes: diffChanges(
          null,
          {
            number: expenseNumber,
            lineId,
            authorizationId: invoice.authorizationId,
            amount: show(gross),
            spentOn: input.paidOn,
            vendor: vendor.name,
            vendorId: invoice.vendorId,
            reference,
            vendorInvoiceId: invoice.id,
          },
          'expense.recorded',
        ),
      });
      const net = gross.sub(retention).sub(setOff);
      const payoutReference = input.reference?.trim() || null;
      await tx.financeVendorPayout.create({
        data: {
          id: payoutId,
          tenantId: this.ctx.txTenantId,
          number,
          kind: 'invoice',
          vendorInvoiceId: invoice.id,
          contractId: invoice.contractId,
          vendorId: invoice.vendorId,
          expenseId,
          gross: show(gross),
          retentionHeld: show(retention),
          advanceSetOff: show(setOff),
          net: show(net),
          method: input.method,
          reference: payoutReference,
          paidOn: asDate(input.paidOn),
          paidById: this.ctx.accountId,
          createdAt: now,
        },
      });
      const paid = await tx.financeVendorInvoice.update({
        where: { id },
        data: { status: 'paid', paidAt: now },
      });
      if (invoice.contractPaymentId)
        await this.bridge.source.settlePayment(tx, invoice.contractPaymentId, {
          paidOn: input.paidOn,
          reference,
        });
      await this.audit.record(tx, {
        action: 'vendor_payout.recorded',
        targetId: payoutId,
        metadata: {
          number,
          kind: 'invoice',
          invoiceId: invoice.id,
          expenseId,
          gross: show(gross),
          retentionHeld: show(retention),
          advanceSetOff: show(setOff),
          net: show(net),
          method: input.method,
          paidOn: input.paidOn,
        },
        ...(payoutReference
          ? { changes: { reference: { changed: true } } }
          : {}),
      });
      return this.load(tx, paid);
    });
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  list(q: {
    status?: InvoiceStatus;
    vendorId?: string;
    contractId?: string;
    purchaseRequestId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<InvoiceRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.financeVendorInvoice.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.vendorId ? { vendorId: q.vendorId } : {},
            q.contractId ? { contractId: q.contractId } : {},
            q.purchaseRequestId
              ? { purchaseRequestId: q.purchaseRequestId }
              : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: InvoiceRecord[] = [];
      for (const i of page.items) items.push(await this.load(tx, i));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<InvoiceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const i = await tx.financeVendorInvoice.findUnique({ where: { id } });
      if (!i) throw invoiceNotFound();
      return this.load(tx, i);
    });
  }

  /**
   * The invoices a vendor's contractors sent in (ADR 0088), newest first:
   * the vendor's own, by the contractor channel.
   */
  sentIn(
    vendorId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<FinanceVendorInvoice>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.financeVendorInvoice.findMany({
        where: {
          AND: [{ vendorId, channel: 'contractor' }, ...PAGE.after(q.cursor)],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  /** What the contract's paid advances have open: paid less set off. */
  async openAdvances(
    tx: TenantTxClient,
    contractId: string,
  ): Promise<Prisma.Decimal> {
    const [row] = await tx.$queryRaw<
      { paid: Prisma.Decimal | null; set_off: Prisma.Decimal | null }[]
    >`
      SELECT (SELECT sum(net) FROM finance_vendor_payouts
               WHERE contract_id = ${contractId}::uuid AND kind = 'advance') AS paid,
             (SELECT sum(advance_set_off) FROM finance_vendor_payouts
               WHERE contract_id = ${contractId}::uuid AND kind = 'invoice') AS set_off`;
    return money(row.paid ?? 0).sub(row.set_off ?? 0);
  }

  private async tell(
    tx: TenantTxClient,
    i: FinanceVendorInvoice,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    if (i.recordedById === this.ctx.accountId) return;
    await this.notifier.notify(tx, [i.recordedById], {
      kind: 'vendor_invoice.decided',
      params: {
        invoiceRef: formatNumber('vendor_invoice', i.number),
        decision,
      },
      targetId: i.id,
    });
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<FinanceVendorInvoice> {
    await tx.$queryRaw`
      SELECT id FROM finance_vendor_invoices WHERE id = ${id}::uuid FOR UPDATE`;
    const i = await tx.financeVendorInvoice.findUnique({ where: { id } });
    if (!i) throw invoiceNotFound();
    return i;
  }

  async load(
    tx: TenantTxClient,
    invoice: FinanceVendorInvoice,
  ): Promise<InvoiceRecord> {
    const lines = await tx.financeVendorInvoiceLine.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { position: 'asc' },
    });
    const payout = await tx.financeVendorPayout.findFirst({
      where: { vendorInvoiceId: invoice.id },
    });
    return {
      invoice,
      lines,
      payout,
      invoiceUrl:
        (await this.files.readUrl(tx, invoice.invoiceFileId))?.url ?? null,
      recordedByMe: invoice.recordedById === this.ctx.accountId,
    };
  }
}
