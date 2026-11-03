import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { ofDateColumn } from '../schedules/local-dates';
import { ticketNumber } from '../tickets/ticket-rules';
import { vendorReference } from '../vendors/vendor-rules';
import { tenderReference } from '../tenders/tender-rules';

/**
 * A contractor's section of a personal-data export (ADR 0036, 0088),
 * `contractor/`, for a contractor account only: the vendor it works for,
 * the offers it took or turned down and the tickets it worked as their
 * technician (numbers, categories, when and how they moved — what a
 * technician's list shows, never a resident), the bids it sent (an amount
 * only once its tender was opened) and the vendor's invoices it sent in
 * (numbers, statuses, totals). Never another person's words or details;
 * the files are the vendor's and the compound's records, not the account's.
 */
@Injectable()
export class ContractorExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('contractor', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    if (s.accountType !== 'contractor') return;
    const me = s.accountId;
    const d = await this.tenantTx.withTenantTx(async (tx) => {
      const account = await tx.account.findUniqueOrThrow({
        where: { id: me },
        select: { vendorId: true },
      });
      const vendor = account.vendorId
        ? await tx.vendor.findUnique({
            where: { id: account.vendorId },
            select: { number: true, name: true },
          })
        : null;
      const offers = await tx.ticketVendorDispatch.findMany({
        where: { decidedById: me },
        orderBy: [{ offeredAt: 'asc' }, { id: 'asc' }],
      });
      const worked = await tx.ticket.findMany({
        where: { technicianId: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          number: true,
          status: true,
          priority: true,
          categoryId: true,
          assignedAt: true,
          completedAt: true,
          closedAt: true,
        },
      });
      const numbers = new Map(
        (
          await tx.ticket.findMany({
            where: {
              id: {
                in: [
                  ...offers.map((o) => o.ticketId),
                  ...worked.map((t) => t.id),
                ],
              },
            },
            select: { id: true, number: true },
          })
        ).map((t) => [t.id, t.number]),
      );
      const categories = new Map(
        (
          await tx.ticketCategory.findMany({
            where: { id: { in: worked.map((t) => t.categoryId) } },
            select: { id: true, key: true },
          })
        ).map((c) => [c.id, c.key]),
      );
      const bids = await tx.tenderBid.findMany({
        where: { submittedById: me },
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      });
      const tenders = new Map(
        (
          await tx.tender.findMany({
            where: { id: { in: bids.map((b) => b.tenderId) } },
            select: { id: true, number: true, title: true, status: true },
          })
        ).map((t) => [t.id, t]),
      );
      const invoices = await tx.financeVendorInvoice.findMany({
        where: { recordedById: me, channel: 'contractor' },
        orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
        select: {
          number: true,
          vendorNumber: true,
          issuedOn: true,
          dueOn: true,
          total: true,
          status: true,
          recordedAt: true,
        },
      });
      return {
        vendor,
        offers,
        worked,
        numbers,
        categories,
        bids,
        tenders,
        invoices,
      };
    });
    yield {
      path: 'contractor/vendor.json',
      json: d.vendor
        ? { reference: vendorReference(d.vendor.number), name: d.vendor.name }
        : null,
    };
    yield {
      path: 'contractor/offers.json',
      json: d.offers.map((o) => ({
        ticketNumber: ticketNumber(d.numbers.get(o.ticketId)!),
        status: o.status,
        offeredAt: o.offeredAt,
        decidedAt: o.decidedAt,
        declineReason: o.declineReason,
        endedAt: o.endedAt,
      })),
    };
    yield {
      path: 'contractor/tickets.json',
      json: d.worked.map((t) => ({
        ticketNumber: ticketNumber(t.number),
        categoryKey: d.categories.get(t.categoryId) ?? null,
        priority: t.priority,
        status: t.status,
        assignedAt: t.assignedAt,
        completedAt: t.completedAt,
        closedAt: t.closedAt,
      })),
    };
    yield {
      path: 'contractor/bids.json',
      json: d.bids.map((b) => {
        const t = d.tenders.get(b.tenderId);
        return {
          tender: t ? tenderReference(t.number) : null,
          title: t?.title ?? null,
          tenderStatus: t?.status ?? null,
          submittedAt: b.submittedAt,
          withdrawnAt: b.withdrawnAt,
          // Sealed until the tender's opening: not even its sender reads it.
          amount: b.amount?.toFixed(2) ?? null,
          durationDays: b.durationDays,
          note: b.note,
        };
      }),
    };
    yield {
      path: 'contractor/invoices.json',
      json: d.invoices.map((i) => ({
        number: `VI-${String(i.number).padStart(6, '0')}`,
        vendorNumber: i.vendorNumber,
        issuedOn: ofDateColumn(i.issuedOn),
        dueOn: ofDateColumn(i.dueOn),
        total: i.total.toFixed(2),
        status: i.status,
        sentAt: i.recordedAt,
      })),
    };
  }
}
