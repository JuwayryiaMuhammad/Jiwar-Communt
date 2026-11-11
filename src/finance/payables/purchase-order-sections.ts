import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  REPORT_MAX_ROWS,
  StaffReports,
  type ReportColumn,
} from '../../core/reports/report-registry';
import { fromDate } from '../db-clock';
import { show } from '../money';
import { InvoiceMatchService } from './invoice-match.service';
import { LIVE_INVOICE } from './payable-rules';

const text = (key: string, en: string, ar: string): ReportColumn => ({
  key,
  en,
  ar,
  kind: 'text',
});
const sum = (key: string, en: string, ar: string): ReportColumn => ({
  key,
  en,
  ar,
  kind: 'money',
  sum: true,
});
const count = (key: string, en: string, ar: string): ReportColumn => ({
  key,
  en,
  ar,
  kind: 'number',
  sum: true,
});

type Money = Prisma.Decimal;
const ref = (n: number) => `PO-${String(n).padStart(6, '0')}`;

/**
 * Purchase orders on the reports platform (ADR 0086, 0094), each read with
 * `finance.payables`, on screen, as a PDF, a workbook or CSV, compared and
 * scheduled; the period's last day is the day they are read as of:
 *
 * - `po_open`: the approved orders not closed, raised by that day — what
 *   was ordered, what has arrived and what has been invoiced — by order,
 *   vendor or delivery month;
 * - `po_received_not_invoiced`: what arrived (accepted on receipts) and no
 *   approved invoice bills yet, at the order's prices and VAT — by order,
 *   vendor or budget category. It is a register, not a ledger balance: the
 *   books recognise a purchase at the invoice's approval (ADR 0092, 0094);
 * - `po_match_exceptions`: the invoices recorded in the period against an
 *   order that do not match it, or were let through — by invoice, vendor or
 *   kind of issue. Companies, orders and amounts only.
 */
@Injectable()
export class PurchaseOrderSections implements OnModuleInit {
  constructor(
    private readonly reports: StaffReports,
    private readonly match: InvoiceMatchService,
  ) {}

  onModuleInit(): void {
    this.reports.register({
      key: 'po_open',
      permission: 'finance.payables',
      title: { en: 'Open purchase orders', ar: 'أوامر الشراء المفتوحة' },
      groupBy: ['order', 'vendor', 'month'],
      columns: (g) => {
        const figures = [
          sum('ordered', 'Ordered', 'المطلوب'),
          sum('received', 'Received', 'المستلم'),
          sum('invoiced', 'Invoiced', 'المفوتر'),
          sum('open', 'Still to invoice', 'المتبقي للفوترة'),
        ];
        if (g === 'vendor')
          return {
            columns: [
              text('vendor', 'Vendor', 'المورد'),
              count('orders', 'Orders', 'الأوامر'),
              ...figures,
            ],
            dimensions: 1,
          };
        if (g === 'month')
          return {
            columns: [
              text('month', 'Delivery month', 'شهر التسليم'),
              count('orders', 'Orders', 'الأوامر'),
              ...figures,
            ],
            dimensions: 1,
          };
        return {
          columns: [
            text('reference', 'Order', 'الأمر'),
            text('vendor', 'Vendor', 'المورد'),
            text('delivery_on', 'Delivery', 'التسليم'),
            ...figures,
          ],
          dimensions: 1,
        };
      },
      read: async (tx, q) => {
        const to = q.period.to;
        const orders = await tx.$queryRaw<
          {
            number: number;
            vendor: string;
            delivery_on: Date;
            ordered: Money;
            received: Money | null;
            invoiced: Money | null;
          }[]
        >`
          SELECT o.number, COALESCE(v.legal_name, v.name) AS vendor, o.delivery_on,
                 o.total AS ordered,
                 (SELECT SUM(round(a.qty * l.unit_price, 2)
                             + round(round(a.qty * l.unit_price, 2) * l.tax_rate / 100, 2))
                    FROM purchase_order_lines l
                    CROSS JOIN LATERAL (
                      SELECT COALESCE(SUM(g.accepted), 0) AS qty
                        FROM goods_receipt_lines g
                        JOIN goods_receipts r ON r.tenant_id = g.tenant_id AND r.id = g.receipt_id
                       WHERE g.purchase_order_line_id = l.id AND r.received_on <= ${to}::date) a
                   WHERE l.purchase_order_id = o.id) AS received,
                 (SELECT SUM(i.total) FROM finance_vendor_invoices i
                   WHERE i.purchase_order_id = o.id AND i.status IN ('approved', 'paid')
                     AND i.issued_on <= ${to}::date) AS invoiced
            FROM purchase_orders o
            JOIN vendors v ON v.tenant_id = o.tenant_id AND v.id = o.vendor_id
           WHERE o.status = 'approved'
             AND (o.raised_at AT TIME ZONE ${q.timeZone})::date <= ${to}::date
           ORDER BY o.delivery_on, o.number
           LIMIT ${REPORT_MAX_ROWS + 1}`;
        const rows = orders.map((o) => {
          const invoiced = new Prisma.Decimal(o.invoiced ?? 0);
          return {
            ref: ref(o.number),
            vendor: o.vendor,
            delivery: fromDate(o.delivery_on),
            ordered: new Prisma.Decimal(o.ordered),
            received: new Prisma.Decimal(o.received ?? 0),
            invoiced,
            open: Prisma.Decimal.max(
              new Prisma.Decimal(o.ordered).sub(invoiced),
              0,
            ),
          };
        });
        const figures = (r: (typeof rows)[number]) => [
          show(r.ordered),
          show(r.received),
          show(r.invoiced),
          show(r.open),
        ];
        if (q.groupBy === 'order')
          return {
            rows: rows.map((r) => [r.ref, r.vendor, r.delivery, ...figures(r)]),
          };
        const key = (r: (typeof rows)[number]) =>
          q.groupBy === 'month' ? r.delivery.slice(0, 7) : r.vendor;
        const groups = new Map<string, typeof rows>();
        for (const r of rows)
          groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
        return {
          rows: [...groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, of]) => [
              k,
              String(of.length),
              ...[
                of.reduce((s, r) => s.add(r.ordered), new Prisma.Decimal(0)),
                of.reduce((s, r) => s.add(r.received), new Prisma.Decimal(0)),
                of.reduce((s, r) => s.add(r.invoiced), new Prisma.Decimal(0)),
                of.reduce((s, r) => s.add(r.open), new Prisma.Decimal(0)),
              ].map(show),
            ]),
        };
      },
    });

    this.reports.register({
      key: 'po_received_not_invoiced',
      permission: 'finance.payables',
      title: { en: 'Received, not invoiced', ar: 'مستلم غير مفوتر' },
      groupBy: ['order', 'vendor', 'category'],
      columns: (g) => {
        if (g === 'order')
          return {
            columns: [
              text('reference', 'Order', 'الأمر'),
              text('vendor', 'Vendor', 'المورد'),
              text('last_received', 'Last received', 'آخر استلام'),
              sum('amount', 'Received, not invoiced', 'مستلم غير مفوتر'),
            ],
            dimensions: 1,
          };
        return {
          columns: [
            g === 'category'
              ? text('category', 'Budget category', 'بند الميزانية')
              : text('vendor', 'Vendor', 'المورد'),
            count('orders', 'Orders', 'الأوامر'),
            sum('amount', 'Received, not invoiced', 'مستلم غير مفوتر'),
          ],
          dimensions: 1,
        };
      },
      read: async (tx, q) => {
        const to = q.period.to;
        const orders = await tx.$queryRaw<
          {
            number: number;
            vendor: string;
            category: string;
            last_received: Date | null;
            amount: Money;
          }[]
        >`
          SELECT o.number, COALESCE(v.legal_name, v.name) AS vendor, b.category,
                 (SELECT max(r.received_on) FROM goods_receipts r
                   WHERE r.purchase_order_id = o.id AND r.received_on <= ${to}::date) AS last_received,
                 SUM(round(x.qty * l.unit_price, 2)
                     + round(round(x.qty * l.unit_price, 2) * l.tax_rate / 100, 2)) AS amount
            FROM purchase_orders o
            JOIN vendors v ON v.tenant_id = o.tenant_id AND v.id = o.vendor_id
            JOIN finance_budget_lines b ON b.tenant_id = o.tenant_id AND b.id = o.budget_line_id
            JOIN purchase_order_lines l ON l.tenant_id = o.tenant_id AND l.purchase_order_id = o.id
            CROSS JOIN LATERAL (
              SELECT GREATEST(
                COALESCE((SELECT SUM(g.accepted) FROM goods_receipt_lines g
                            JOIN goods_receipts r ON r.tenant_id = g.tenant_id AND r.id = g.receipt_id
                           WHERE g.purchase_order_line_id = l.id AND r.received_on <= ${to}::date), 0)
                - COALESCE((SELECT SUM(il.quantity) FROM finance_vendor_invoice_lines il
                              JOIN finance_vendor_invoices i
                                ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
                             WHERE il.purchase_order_line_id = l.id
                               AND i.status IN ('approved', 'paid')
                               AND i.issued_on <= ${to}::date), 0), 0) AS qty) x
           WHERE o.status IN ('approved', 'closed')
             AND (o.raised_at AT TIME ZONE ${q.timeZone})::date <= ${to}::date
           GROUP BY o.id, o.number, v.legal_name, v.name, b.category
          HAVING SUM(x.qty) > 0
           ORDER BY o.number
           LIMIT ${REPORT_MAX_ROWS + 1}`;
        if (q.groupBy === 'order')
          return {
            rows: orders.map((o) => [
              ref(o.number),
              o.vendor,
              o.last_received ? fromDate(o.last_received) : null,
              show(o.amount),
            ]),
          };
        const groups = new Map<string, typeof orders>();
        for (const o of orders) {
          const k = q.groupBy === 'category' ? o.category : o.vendor;
          groups.set(k, [...(groups.get(k) ?? []), o]);
        }
        return {
          rows: [...groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, of]) => [
              k,
              String(of.length),
              show(of.reduce((s, o) => s.add(o.amount), new Prisma.Decimal(0))),
            ]),
        };
      },
    });

    this.reports.register({
      key: 'po_match_exceptions',
      permission: 'finance.payables',
      title: { en: 'Match exceptions', ar: 'استثناءات المطابقة' },
      groupBy: ['invoice', 'vendor', 'issue'],
      columns: (g) => {
        if (g === 'invoice')
          return {
            columns: [
              text('reference', 'Invoice', 'الفاتورة'),
              text('order', 'Order', 'الأمر'),
              text('vendor', 'Vendor', 'المورد'),
              text('status', 'Match', 'المطابقة'),
              count('issues', 'Issues', 'الفروق'),
              sum('amount', 'Amount over', 'قيمة الفرق'),
            ],
            dimensions: 1,
          };
        return {
          columns: [
            g === 'issue'
              ? text('issue', 'Issue', 'نوع الفرق')
              : text('vendor', 'Vendor', 'المورد'),
            count('invoices', 'Invoices', 'الفواتير'),
            sum('amount', 'Amount over', 'قيمة الفرق'),
          ],
          dimensions: 1,
        };
      },
      read: async (tx, q) => {
        const ids = await tx.$queryRaw<{ id: string }[]>`
          SELECT i.id FROM finance_vendor_invoices i
           WHERE i.purchase_order_id IS NOT NULL
             AND i.status = ANY(${[...LIVE_INVOICE]}::text[])
             AND (i.recorded_at AT TIME ZONE ${q.timeZone})::date
                 BETWEEN ${q.period.from}::date AND ${q.period.to}::date
           ORDER BY i.number
           LIMIT ${REPORT_MAX_ROWS + 1}`;
        const invoices = await tx.financeVendorInvoice.findMany({
          where: { id: { in: ids.map((r) => r.id) } },
          orderBy: { number: 'asc' },
        });
        const matches = await this.match.evaluateMany(tx, invoices);
        const vendors = new Map(
          (
            await tx.vendor.findMany({
              where: {
                id: { in: [...new Set(invoices.map((i) => i.vendorId))] },
              },
              select: { id: true, name: true, legalName: true },
            })
          ).map((v) => [v.id, v.legalName ?? v.name]),
        );
        const rows = invoices.flatMap((i) => {
          const m = matches.get(i.id);
          if (!m || m.status === 'matched') return [];
          return [
            {
              ref: `VI-${String(i.number).padStart(6, '0')}`,
              order: ref(m.orderNumber),
              vendor: vendors.get(i.vendorId) ?? '',
              status: m.status,
              issues: m.issues,
            },
          ];
        });
        const over = (issues: { amount: string }[]) =>
          issues.reduce((s, x) => s.add(x.amount), new Prisma.Decimal(0));
        if (q.groupBy === 'invoice')
          return {
            rows: rows.map((r) => [
              r.ref,
              r.order,
              r.vendor,
              r.status,
              String(r.issues.length),
              show(over(r.issues)),
            ]),
          };
        if (q.groupBy === 'issue') {
          const kinds = new Map<
            string,
            { invoices: Set<string>; amount: Money }
          >();
          for (const r of rows)
            for (const x of r.issues) {
              const k = kinds.get(x.kind) ?? {
                invoices: new Set<string>(),
                amount: new Prisma.Decimal(0),
              };
              k.invoices.add(r.ref);
              k.amount = k.amount.add(x.amount);
              kinds.set(x.kind, k);
            }
          return {
            rows: [...kinds.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, String(v.invoices.size), show(v.amount)]),
          };
        }
        const vendorsOf = new Map<string, typeof rows>();
        for (const r of rows)
          vendorsOf.set(r.vendor, [...(vendorsOf.get(r.vendor) ?? []), r]);
        return {
          rows: [...vendorsOf.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, of]) => [
              k,
              String(of.length),
              show(
                of.reduce(
                  (s, r) => s.add(over(r.issues)),
                  new Prisma.Decimal(0),
                ),
              ),
            ]),
        };
      },
    });
  }
}
