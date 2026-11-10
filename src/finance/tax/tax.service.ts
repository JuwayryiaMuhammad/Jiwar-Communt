import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type FinanceTaxPayment,
  type FinanceVatDeclaration,
  type FinanceWithholdingCertificate,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import type { LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { drawCertificate } from '../../core/pdf/certificate';
import { PdfRenderer } from '../../core/pdf/pdf-renderer';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, dbNow, fromDate } from '../db-clock';
import { lockLedgerMonths } from '../gl/gl-entries.service';
import { monthsBetween, nextMonth } from '../gl/gl-rules';
import { money, show, ZERO } from '../money';
import { CashAccountsService } from '../treasury/cash-accounts.service';
import { TreasuryCommon } from '../treasury/treasury-common';
import type { StaffRefView } from '../treasury/views/treasury.views';
import {
  declarationOf,
  quarterEnd,
  quarterFirst,
  quarterLabel,
  quarterOf,
  type TaxPaymentKind,
} from './tax-rules';
import { certificateContent } from './withholding-certificates';

type Money = Prisma.Decimal;

/** A month's VAT: its figures from the ledger, and its declaration if made. */
export interface VatMonthRead {
  month: LocalDate;
  status: 'open' | 'ready' | 'declared';
  /** The ledger closed it. */
  ledgerClosed: boolean;
  taxableSales: Money;
  outputVat: Money;
  taxablePurchases: Money;
  inputVat: Money;
  carriedIn: Money;
  netDue: Money;
  carriedOut: Money;
  declarationId: string | null;
  declaredAt: Date | null;
  declaredBy: StaffRefView | null;
  paid: Money;
  open: Money;
}

export interface WithholdingQuarterRead {
  quarter: string;
  startsOn: LocalDate;
  endsOn: LocalDate;
  certificates: number;
  withheld: Money;
  paid: Money;
  open: Money;
}

export interface CertificateRead {
  id: string;
  number: string;
  payoutId: string;
  payoutNumber: string;
  vendorId: string;
  vendorName: string;
  vendorTaxNumber: string | null;
  category: string;
  rate: Money;
  base: Money;
  amount: Money;
  paidOn: LocalDate;
  quarter: string;
  createdAt: Date;
}

export interface TaxPaymentRead {
  id: string;
  number: string;
  kind: TaxPaymentKind;
  declarationId: string | null;
  month: LocalDate | null;
  quarter: string | null;
  amount: Money;
  paidOn: LocalDate;
  method: string;
  reference: string | null;
  cashAccountId: string;
  paidBy: StaffRefView;
  createdAt: Date;
}

/** The most months the VAT page lists, newest first. */
export const VAT_MONTHS_MAX = 36;
/** The most quarters the withholding page lists. */
export const WITHHOLDING_QUARTERS_MAX = 16;

const CERT_PAGE = keysetCursor('createdAt', 'desc');
const PAY_PAGE = keysetCursor('createdAt', 'desc');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });
export const declarationNotFound = () =>
  appError.notFound(
    ErrorCode.TAX_DECLARATION_NOT_FOUND,
    'Declaration not found',
  );
export const certificateNotFound = () =>
  appError.notFound(
    ErrorCode.WITHHOLDING_CERTIFICATE_NOT_FOUND,
    'Certificate not found',
  );

interface MonthFigures {
  taxableSales: Money;
  outputVat: Money;
  taxablePurchases: Money;
  inputVat: Money;
}

/**
 * VAT declared and taxes paid (ADR 0093).
 *
 * - **A month's VAT** is read from the ledger, by the entries' days: output
 *   VAT (VAT payable from invoices and credit notes), input VAT (VAT
 *   recoverable from vendors' invoices approved, and called off), and the
 *   net of the revenue and expense lines of those entries as the taxable
 *   sales and purchases.
 * - **Declared** (`finance.ledger_write`) once the ledger closed the month
 *   (`TAX_MONTH_NOT_CLOSED`), in order from the month VAT began
 *   (`TAX_MONTH_OUT_OF_ORDER {next}`), once (`TAX_MONTH_DECLARED`): its
 *   figures are stored, what the month before carried forward set off, and
 *   due or carried forward. The ledger's months lock is held, and the
 *   month is not reopened after (the database refuses it too), so the
 *   declared figures stay the ledger's.
 * - **Paid** (`finance.ledger_write`): VAT against a declaration's due,
 *   withholding against a calendar quarter's certificates, at most what is
 *   still open (`TAX_PAYMENT_EXCEEDED {open}`), from a treasury account of
 *   the method's kind, as a vendor's payout is (ADR 0085).
 */
@Injectable()
export class TaxService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly common: TreasuryCommon,
    private readonly access: FinanceAccess,
    private readonly audit: AuditService,
    private readonly cashAccounts: CashAccountsService,
    private readonly globalDb: GlobalDbService,
    private readonly pdf: PdfRenderer,
  ) {}

  // --------------------------------------------------------------------------
  // VAT
  // --------------------------------------------------------------------------

  /** From the month VAT began to this one, newest first (at most 36). */
  vatMonths(): Promise<VatMonthRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const s = await tx.financeSettings.findFirst({
        select: { vatSince: true },
      });
      if (!s?.vatSince) return [];
      const today = await this.common.today(tx);
      const months = monthsBetween(fromDate(s.vatSince), today)
        .reverse()
        .slice(0, VAT_MONTHS_MAX);
      return this.monthsIn(tx, months);
    });
  }

  vatMonth(month: LocalDate): Promise<VatMonthRead> {
    return this.tenantTx.withTenantTx(
      async (tx) => (await this.monthsIn(tx, [month]))[0],
    );
  }

  declare(month: LocalDate): Promise<VatMonthRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await lockLedgerMonths(tx, this.ctx.txTenantId);
      const s = await tx.financeSettings.findFirst({
        select: { vatSince: true },
      });
      if (!s?.vatSince)
        throw appError.conflict(
          ErrorCode.TAX_VAT_NOT_REGISTERED,
          'The compound was never registered for VAT',
        );
      if (
        await tx.financeVatDeclaration.findFirst({
          where: { month: asDate(month) },
          select: { id: true },
        })
      )
        throw appError.conflict(
          ErrorCode.TAX_MONTH_DECLARED,
          'That month’s VAT is declared',
          { params: { month: month.slice(0, 7) } },
        );
      const last = await tx.financeVatDeclaration.findFirst({
        orderBy: { month: 'desc' },
      });
      const next = last
        ? nextMonth(fromDate(last.month))
        : `${fromDate(s.vatSince).slice(0, 7)}-01`;
      if (month !== next)
        throw appError.conflict(
          ErrorCode.TAX_MONTH_OUT_OF_ORDER,
          'Months are declared in order',
          { params: { next: next.slice(0, 7) } },
        );
      const closed = await tx.glPeriod.findFirst({
        where: { month: asDate(month), status: 'closed' },
        select: { month: true },
      });
      if (!closed)
        throw appError.conflict(
          ErrorCode.TAX_MONTH_NOT_CLOSED,
          'Close the month in the ledger before declaring it',
          { params: { month: month.slice(0, 7) } },
        );
      const f = (await this.figures(tx, [month])).get(month) ?? zeroFigures();
      const carriedIn = last ? money(last.carriedOut) : ZERO;
      const d = declarationOf({
        output: f.outputVat,
        input: f.inputVat,
        carriedIn,
      });
      const id = newId();
      await tx.financeVatDeclaration.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          month: asDate(month),
          taxableSales: show(f.taxableSales),
          outputVat: show(f.outputVat),
          taxablePurchases: show(f.taxablePurchases),
          inputVat: show(f.inputVat),
          carriedIn: show(carriedIn),
          netDue: show(d.netDue),
          carriedOut: show(d.carriedOut),
          declaredByAccountId: this.ctx.accountId,
          declaredAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'vat_declaration.declared',
        targetId: id,
        metadata: {
          month: month.slice(0, 7),
          taxableSales: show(f.taxableSales),
          outputVat: show(f.outputVat),
          taxablePurchases: show(f.taxablePurchases),
          inputVat: show(f.inputVat),
          carriedIn: show(carriedIn),
          netDue: show(d.netDue),
          carriedOut: show(d.carriedOut),
        },
      });
      return (await this.monthsIn(tx, [month]))[0];
    });
  }

  /** The months' rows: the declared ones as declared, the rest live. */
  private async monthsIn(
    tx: TenantTxClient,
    months: readonly LocalDate[],
  ): Promise<VatMonthRead[]> {
    if (!months.length) return [];
    const dates = months.map(asDate);
    // The months' declarations, and the month's before each: what it
    // carried forward is the next one's to set off.
    const declared = await tx.financeVatDeclaration.findMany({
      where: {
        month: { in: [...dates, ...months.map((m) => asDate(lastMonth(m)))] },
      },
    });
    const live = await this.figures(tx, months);
    const closed = new Set(
      (
        await tx.glPeriod.findMany({
          where: { month: { in: dates }, status: 'closed' },
          select: { month: true },
        })
      ).map((p) => fromDate(p.month)),
    );
    const paid = await tx.financeTaxPayment.groupBy({
      by: ['declarationId'],
      where: { declarationId: { in: declared.map((d) => d.id) } },
      _sum: { amount: true },
    });
    const ref = await this.common.refs(
      tx,
      declared.map((d) => d.declaredByAccountId),
    );
    return months.map((m) => {
      const d = declared.find((x) => fromDate(x.month) === m);
      if (d) {
        const p = money(
          paid.find((x) => x.declarationId === d.id)?._sum.amount ?? 0,
        );
        return {
          ...declaredRead(d),
          month: m,
          status: 'declared' as const,
          ledgerClosed: closed.has(m),
          declaredBy: ref(d.declaredByAccountId),
          paid: p,
          open: money(d.netDue).sub(p),
        };
      }
      const f = live.get(m) ?? zeroFigures();
      const before = declared.find((x) => fromDate(x.month) === lastMonth(m));
      const carriedIn = money(before?.carriedOut ?? 0);
      const r = declarationOf({
        output: f.outputVat,
        input: f.inputVat,
        carriedIn,
      });
      return {
        month: m,
        status: closed.has(m) ? ('ready' as const) : ('open' as const),
        ledgerClosed: closed.has(m),
        ...f,
        carriedIn,
        netDue: r.netDue,
        carriedOut: r.carriedOut,
        declarationId: null,
        declaredAt: null,
        declaredBy: null,
        paid: ZERO,
        open: ZERO,
      };
    });
  }

  /** The months' VAT from the ledger, in one aggregate query. */
  async figures(
    tx: TenantTxClient,
    months: readonly LocalDate[],
  ): Promise<Map<LocalDate, MonthFigures>> {
    if (!months.length) return new Map();
    const sorted = [...months].sort();
    const from = sorted[0];
    const to = addMonth(sorted[sorted.length - 1]);
    const rows = await tx.$queryRaw<
      {
        m: Date;
        sales: Prisma.Decimal | null;
        output: Prisma.Decimal | null;
        purchases: Prisma.Decimal | null;
        input: Prisma.Decimal | null;
      }[]
    >`
      WITH taxed AS (
        SELECT e.tenant_id, e.id, date_trunc('month', e.posted_on)::date AS m
          FROM gl_entries e
         WHERE e.source IN ('invoice', 'credit_note', 'vendor_invoice', 'vendor_invoice_cancel')
           AND e.posted_on >= ${from}::date AND e.posted_on < ${to}::date
           AND EXISTS (SELECT 1 FROM gl_lines x
                         JOIN gl_accounts k ON k.tenant_id = x.tenant_id AND k.id = x.account_id
                        WHERE x.tenant_id = e.tenant_id AND x.entry_id = e.id
                          AND k.system_key IN ('vat_payable', 'vat_receivable'))
      )
      SELECT t.m,
             SUM(l.credit - l.debit) FILTER (WHERE a.type = 'revenue') AS sales,
             SUM(l.credit - l.debit) FILTER (WHERE a.system_key = 'vat_payable') AS output,
             SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense') AS purchases,
             SUM(l.debit - l.credit) FILTER (WHERE a.system_key = 'vat_receivable') AS input
        FROM taxed t
        JOIN gl_lines l ON l.tenant_id = t.tenant_id AND l.entry_id = t.id
        JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       GROUP BY t.m`;
    return new Map(
      rows.map((r) => [
        fromDate(r.m),
        {
          taxableSales: money(r.sales ?? 0),
          outputVat: money(r.output ?? 0),
          taxablePurchases: money(r.purchases ?? 0),
          inputVat: money(r.input ?? 0),
        },
      ]),
    );
  }

  // --------------------------------------------------------------------------
  // Withholding
  // --------------------------------------------------------------------------

  certificates(q: {
    quarter?: string;
    vendorId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<CertificateRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const first = q.quarter ? quarterFirst(q.quarter) : null;
      const rows = await tx.financeWithholdingCertificate.findMany({
        where: {
          AND: [
            first
              ? {
                  paidOn: {
                    gte: asDate(first),
                    lte: asDate(quarterEnd(first)),
                  },
                }
              : {},
            q.vendorId ? { vendorId: q.vendorId } : {},
            ...CERT_PAGE.after(q.cursor),
          ],
        },
        orderBy: CERT_PAGE.orderBy,
        take: limit + 1,
      });
      const page = CERT_PAGE.toPage(rows, limit);
      return {
        items: await this.certificateReads(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  certificate(id: string): Promise<CertificateRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const c = await tx.financeWithholdingCertificate.findUnique({
        where: { id },
      });
      if (!c) throw certificateNotFound();
      return (await this.certificateReads(tx, [c]))[0];
    });
  }

  /** A certificate as a PDF for the vendor, drawn on demand, never stored. */
  certificatePdf(id: string): Promise<{ name: string; body: Buffer }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.financeWithholdingCertificate.findUnique({
        where: { id },
      });
      if (!row) throw certificateNotFound();
      const [c] = await this.certificateReads(tx, [row]);
      const payout = await tx.financeVendorPayout.findUniqueOrThrow({
        where: { id: c.payoutId },
        select: { vendorInvoiceId: true },
      });
      const invoice = payout.vendorInvoiceId
        ? await tx.financeVendorInvoice.findUnique({
            where: { id: payout.vendorInvoiceId },
            select: { number: true, vendorNumber: true },
          })
        : null;
      const s = await tx.financeSettings.findFirst({
        select: { vatNumber: true },
      });
      const { name: compound } = await this.globalDb
        .in(tx)
        .tenant.findUniqueOrThrow({
          where: { id: this.ctx.txTenantId },
          select: { name: true },
        });
      const body = await this.pdf.render(
        { title: c.number, createdAt: c.createdAt },
        (page) =>
          drawCertificate(
            page,
            certificateContent(compound, {
              number: c.number,
              compoundTaxNumber: s?.vatNumber ?? null,
              vendorName: c.vendorName,
              vendorTaxNumber: c.vendorTaxNumber,
              payoutNumber: c.payoutNumber,
              invoiceNumber: invoice
                ? formatNumber('vendor_invoice', invoice.number)
                : null,
              vendorInvoiceNumber: invoice?.vendorNumber ?? null,
              category: c.category,
              rate: show(c.rate),
              base: show(c.base),
              amount: show(c.amount),
              paidOn: c.paidOn,
              quarter: c.quarter,
            }),
          ),
      );
      return { name: `${c.number}.pdf`, body };
    });
  }

  /** The quarters with certificates or payments, newest first (at most 16). */
  quarters(): Promise<WithholdingQuarterRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.$queryRaw<
        { q: Date; n: number; withheld: Prisma.Decimal; paid: Prisma.Decimal }[]
      >`
        WITH c AS (
          SELECT date_trunc('quarter', paid_on)::date AS q, count(*)::int AS n,
                 SUM(amount) AS withheld
            FROM finance_withholding_certificates GROUP BY 1
        ), p AS (
          SELECT quarter AS q, SUM(amount) AS paid
            FROM finance_tax_payments WHERE kind = 'withholding' GROUP BY 1
        )
        SELECT COALESCE(c.q, p.q) AS q, COALESCE(c.n, 0) AS n,
               COALESCE(c.withheld, 0) AS withheld, COALESCE(p.paid, 0) AS paid
          FROM c FULL JOIN p ON p.q = c.q
         ORDER BY 1 DESC
         LIMIT ${WITHHOLDING_QUARTERS_MAX}`;
      return rows.map((r) => {
        const first = fromDate(r.q);
        const withheld = money(r.withheld);
        const paid = money(r.paid);
        return {
          quarter: quarterLabel(first),
          startsOn: first,
          endsOn: quarterEnd(first),
          certificates: r.n,
          withheld,
          paid,
          open: withheld.sub(paid),
        };
      });
    });
  }

  private async certificateReads(
    tx: TenantTxClient,
    rows: readonly FinanceWithholdingCertificate[],
  ): Promise<CertificateRead[]> {
    if (!rows.length) return [];
    const vendors = await tx.vendor.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.vendorId))] } },
      select: { id: true, name: true, legalName: true, taxNumber: true },
    });
    const payouts = await tx.financeVendorPayout.findMany({
      where: { id: { in: rows.map((r) => r.payoutId) } },
      select: { id: true, number: true },
    });
    return rows.map((r) => {
      const v = vendors.find((x) => x.id === r.vendorId);
      const p = payouts.find((x) => x.id === r.payoutId);
      const paidOn = fromDate(r.paidOn);
      return {
        id: r.id,
        number: formatNumber('withholding_certificate', r.number),
        payoutId: r.payoutId,
        payoutNumber: p ? formatNumber('payout', p.number) : '',
        vendorId: r.vendorId,
        vendorName: v?.legalName ?? v?.name ?? '',
        vendorTaxNumber: v?.taxNumber ?? null,
        category: r.category,
        rate: money(r.rate),
        base: money(r.base),
        amount: money(r.amount),
        paidOn,
        quarter: quarterLabel(quarterOf(paidOn)),
        createdAt: r.createdAt,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Paying the tax authority
  // --------------------------------------------------------------------------

  pay(input: {
    kind: TaxPaymentKind;
    declarationId?: string;
    quarter?: string;
    amount: string;
    paidOn: LocalDate;
    method: string;
    reference?: string;
    cashAccountId: string;
  }): Promise<TaxPaymentRead> {
    const fields: FieldError[] = [];
    if (input.kind === 'vat') {
      if (!input.declarationId)
        fields.push({
          field: 'declarationId',
          code: FieldErrorCode.FIELD_REQUIRED,
        });
      if (input.quarter !== undefined)
        fields.push({
          field: 'quarter',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    } else {
      if (input.declarationId !== undefined)
        fields.push({
          field: 'declarationId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      if (!input.quarter)
        fields.push({ field: 'quarter', code: FieldErrorCode.FIELD_REQUIRED });
    }
    if (fields.length) throw invalid(fields);
    const amount = money(input.amount);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const today = await this.common.today(tx);
      if (input.paidOn > today)
        throw invalid([
          {
            field: 'paidOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { max: today },
          },
        ]);
      const key = input.kind === 'vat' ? input.declarationId! : input.quarter!;
      // One payment of a declaration or a quarter at a time.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`tax-payment:${this.ctx.txTenantId}`}),
                                     hashtext(${key}))`;
      let declaration: FinanceVatDeclaration | null = null;
      let quarter: LocalDate | null = null;
      let open: Money;
      if (input.kind === 'vat') {
        declaration = await tx.financeVatDeclaration.findUnique({
          where: { id: input.declarationId },
        });
        if (!declaration) throw declarationNotFound();
        const paid = await tx.financeTaxPayment.aggregate({
          where: { declarationId: declaration.id },
          _sum: { amount: true },
        });
        open = money(declaration.netDue).sub(paid._sum.amount ?? 0);
      } else {
        quarter = quarterFirst(input.quarter!);
        if (quarter > today)
          throw invalid([
            {
              field: 'quarter',
              code: FieldErrorCode.INVALID_VALUE,
              params: { max: quarterLabel(quarterOf(today)) },
            },
          ]);
        const withheld = await tx.financeWithholdingCertificate.aggregate({
          where: {
            paidOn: { gte: asDate(quarter), lte: asDate(quarterEnd(quarter)) },
          },
          _sum: { amount: true },
        });
        const paid = await tx.financeTaxPayment.aggregate({
          where: { kind: 'withholding', quarter: asDate(quarter) },
          _sum: { amount: true },
        });
        open = money(withheld._sum.amount ?? 0).sub(paid._sum.amount ?? 0);
      }
      if (amount.gt(open))
        throw appError.conflict(
          ErrorCode.TAX_PAYMENT_EXCEEDED,
          'More than is still due',
          { params: { open: show(open.gt(ZERO) ? open : ZERO) } },
        );
      // The treasury's account (ADR 0085), locked; a cash box never below zero.
      const cashAccountId = (await this.cashAccounts.payoutAccount(tx, {
        cashAccountId: input.cashAccountId,
        method: input.method,
        net: amount,
        paidOn: input.paidOn,
      }))!;
      const id = newId();
      const number = await takeNumbers(tx, this.ctx.txTenantId, 'tax_payment');
      const reference = input.reference?.trim() || null;
      const row = await tx.financeTaxPayment.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          kind: input.kind,
          declarationId: declaration?.id ?? null,
          quarter: quarter ? asDate(quarter) : null,
          amount: show(amount),
          paidOn: asDate(input.paidOn),
          method: input.method,
          reference,
          cashAccountId,
          paidByAccountId: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.cashAccounts.taxPaymentMovement(tx, {
        taxPaymentId: id,
        accountId: cashAccountId,
        amount,
        paidOn: input.paidOn,
      });
      await this.audit.record(tx, {
        action: 'tax_payment.recorded',
        targetId: id,
        metadata: {
          number: formatNumber('tax_payment', number),
          kind: input.kind,
          declarationId: declaration?.id ?? null,
          quarter: quarter ? quarterLabel(quarter) : null,
          amount: show(amount),
          method: input.method,
          cashAccountId,
          paidOn: input.paidOn,
        },
        ...(reference ? { changes: { reference: { changed: true } } } : {}),
      });
      return (await this.paymentReads(tx, [row]))[0];
    });
  }

  payments(q: {
    kind?: TaxPaymentKind;
    cursor?: string;
    limit?: number;
  }): Promise<Page<TaxPaymentRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.financeTaxPayment.findMany({
        where: {
          AND: [q.kind ? { kind: q.kind } : {}, ...PAY_PAGE.after(q.cursor)],
        },
        orderBy: PAY_PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAY_PAGE.toPage(rows, limit);
      return {
        items: await this.paymentReads(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  private async paymentReads(
    tx: TenantTxClient,
    rows: readonly FinanceTaxPayment[],
  ): Promise<TaxPaymentRead[]> {
    if (!rows.length) return [];
    const ref = await this.common.refs(
      tx,
      rows.map((r) => r.paidByAccountId),
    );
    const ids = rows.flatMap((r) => (r.declarationId ? [r.declarationId] : []));
    const months = ids.length
      ? await tx.financeVatDeclaration.findMany({
          where: { id: { in: ids } },
          select: { id: true, month: true },
        })
      : [];
    return rows.map((r) => ({
      id: r.id,
      number: formatNumber('tax_payment', r.number),
      kind: r.kind as TaxPaymentKind,
      declarationId: r.declarationId,
      month: (() => {
        const d = months.find((x) => x.id === r.declarationId);
        return d ? fromDate(d.month) : null;
      })(),
      quarter: r.quarter ? quarterLabel(fromDate(r.quarter)) : null,
      amount: money(r.amount),
      paidOn: fromDate(r.paidOn),
      method: r.method,
      reference: r.reference,
      cashAccountId: r.cashAccountId,
      paidBy: ref(r.paidByAccountId),
      createdAt: r.createdAt,
    }));
  }
}

function zeroFigures(): MonthFigures {
  return {
    taxableSales: ZERO,
    outputVat: ZERO,
    taxablePurchases: ZERO,
    inputVat: ZERO,
  };
}

function declaredRead(d: FinanceVatDeclaration) {
  return {
    taxableSales: money(d.taxableSales),
    outputVat: money(d.outputVat),
    taxablePurchases: money(d.taxablePurchases),
    inputVat: money(d.inputVat),
    carriedIn: money(d.carriedIn),
    netDue: money(d.netDue),
    carriedOut: money(d.carriedOut),
    declarationId: d.id,
    declaredAt: d.declaredAt,
  };
}

/** The first day of the month after a month's first day. */
const addMonth = (m: LocalDate): LocalDate => nextMonth(m);

/** The first day of the month before a month's first day. */
function lastMonth(m: LocalDate): LocalDate {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1
    ? `${y - 1}-12-01`
    : `${y}-${String(mo - 1).padStart(2, '0')}-01`;
}
