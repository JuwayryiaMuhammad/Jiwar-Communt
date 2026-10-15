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
import { show } from '../money';
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
 *   the unit — never Paymob's secrets.
 *
 * Nothing here names another person: payments show no recorder.
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
  }
}
