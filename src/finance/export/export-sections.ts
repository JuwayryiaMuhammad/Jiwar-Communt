import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityFinancePort } from '../../community';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { InvoicesService } from '../invoices/invoices.service';
import type { InvoiceView } from '../invoices/views/invoice.views';
import { formatNumber } from '../counters';
import { show } from '../money';
import { heldOf } from '../deposits/deposits.service';
import { PaymentsService } from '../payments/payments.service';
import type { PaymentView } from '../payments/views/payment.views';

/**
 * The finance section of a personal-data export (ADR 0046). It runs as the
 * account and reads through the account's own services and views:
 *
 * - `finance/<unitCode>.json`: for each unit whose money the account sees
 *   now, its statement, every invoice and every payment (receipts
 *   included), as the app shows them;
 * - `finance/checkouts.json`: the checkouts the account opened, whatever
 *   the unit — never Paymob's secrets;
 * - `finance/disputes.json`: the invoice disputes the account opened,
 *   whatever the unit, with its own words (ADR 0048). Their photos are not
 *   exported: once attached they are no longer the account's own files.
 *
 * Nothing here names another person: payments show no recorder.
 * Refunds are on each unit's statement.
 */
@Injectable()
export class FinanceExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityFinancePort,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.sections.register('finance', (s) => this.own(s));
    this.sections.register('clearances', (s) => this.clearances(s));
    this.sections.register('deposits', (s) => this.deposits(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const units = await this.tenantTx.withTenantTx((tx) =>
      this.community.financeUnits(tx, s.accountId),
    );
    const known = await this.tenantTx.withTenantTx((tx) =>
      this.community.units(tx, units),
    );
    for (const unitId of units) {
      const invoices: InvoiceView[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.invoices.forUnit(unitId, {
          cursor,
          limit: 100,
        });
        invoices.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const payments: PaymentView[] = [];
      cursor = undefined;
      do {
        const page = await this.payments.forUnit(unitId, {
          cursor,
          limit: 100,
        });
        payments.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      yield {
        path: `finance/${known.get(unitId)?.code ?? unitId}.json`,
        json: {
          unitId,
          statement: await this.payments.statement(unitId, false),
          invoices,
          payments,
        },
      };
    }
    const sessions = await this.tenantTx.withTenantTx((tx) =>
      tx.paymentSession.findMany({
        where: { accountId: s.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          unitId: true,
          status: true,
          amount: true,
          currency: true,
          paymentId: true,
          createdAt: true,
          resolvedAt: true,
        },
      }),
    );
    yield {
      path: 'finance/checkouts.json',
      json: sessions.map((x) => ({ ...x, amount: show(x.amount) })),
    };
    const disputes = await this.tenantTx.withTenantTx((tx) =>
      tx.invoiceDispute.findMany({
        where: { openedById: s.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          invoice: { select: { number: true } },
          creditNote: { select: { amount: true } },
        },
      }),
    );
    yield {
      path: 'finance/disputes.json',
      json: disputes.map((d) => ({
        id: d.id,
        invoiceId: d.invoiceId,
        invoiceNumber: formatNumber('invoice', d.invoice.number),
        unitId: d.unitId,
        reasonCode: d.reasonCode,
        text: d.text,
        photo: d.photoFileId !== null,
        status: d.status,
        decidedAt: d.decidedAt,
        decisionReasonCode: d.decisionReasonCode,
        creditedAmount: d.creditNote ? show(d.creditNote.amount) : null,
        createdAt: d.createdAt,
      })),
    };
  }

  /**
   * `clearances.json` (ADR 0062): the clearance certificates the account
   * asked for — number, unit, the instant, the last valid day and the code
   * that checks it. The certificate itself is drawn on demand, not kept.
   */
  private async *clearances(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.financeClearance.findMany({
        where: { requestedBy: s.accountId },
        orderBy: { number: 'asc' },
      });
      const units = await this.community.units(
        tx,
        found.map((c) => c.unitId),
      );
      return found.map((c) => ({
        number: formatNumber('clearance', c.number),
        unitCode: units.get(c.unitId)?.code ?? null,
        asOf: c.asOf,
        validUntil: c.validUntil.toISOString().slice(0, 10),
        verifyCode: c.verifyCode,
      }));
    });
    yield { path: 'clearances.json', json: rows };
  }

  /**
   * `deposits.json` (ADR 0062): the deposits the management holds for the
   * account's occupancies — number, unit, kind, amount, what is held, and
   * every event (refund asked, refunded, deducted with its code).
   */
  private async *deposits(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.financeDeposit.findMany({
        where: { occupancy: { accountId: s.accountId } },
        orderBy: { number: 'asc' },
        include: { events: { orderBy: { at: 'asc' } } },
      });
      const units = await this.community.units(
        tx,
        found.map((d) => d.unitId),
      );
      return found.map((d) => ({
        number: formatNumber('deposit', d.number),
        unitCode: units.get(d.unitId)?.code ?? null,
        kind: d.kind,
        amount: show(d.amount),
        held: show(heldOf(d)),
        receivedOn: d.receivedOn.toISOString().slice(0, 10),
        events: d.events.map((e) => ({
          kind: e.kind,
          amount: e.amount ? show(e.amount) : null,
          reasonCode: e.reasonCode,
          at: e.at,
        })),
      }));
    });
    yield { path: 'deposits.json', json: rows };
  }
}
