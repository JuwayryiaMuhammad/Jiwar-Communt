import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  ResidentItems,
  wantsNumber,
  type ItemQuery,
  type PageRequest,
  type ResidentItem,
} from '../../core/resident-items/resident-items';
import { formatNumber } from '../counters';
import { unitCredit } from '../payments/allocation';
import { InvoicesService } from './invoices.service';

/**
 * Finance in the resident's lists and search (ADR 0058), on the units whose
 * money the caller sees (`financeView`), as `GET /invoices/{id}/disputes`
 * and `GET /units/{unitId}/invoices` show them:
 * - an invoice dispute is something the unit asked for, listed by its last
 *   move (opened, decided, taken to the board, back from it);
 * - an invoice is found by its number (`INV-…`).
 */
@Injectable()
export class ResidentFinanceItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
    private readonly community: CommunityFinancePort,
    private readonly invoices: InvoicesService,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'invoice_dispute',
      group: 'request',
      page: (tx, q) => this.disputes(tx, q, null),
      search: (tx, q, take, caller) =>
        wantsNumber(q, 'INV')
          ? this.disputes(
              tx,
              { after: null, take, state: null, caller },
              q.number,
            )
          : Promise.resolve([]),
    });
    // The unit's credit awaiting a refund: the one held money (ADR 0058).
    this.items.registerHold('unit_credit', async (tx, unitId) => {
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps?.financeView) return null;
      return (await unitCredit(tx, unitId)).gt(0)
        ? { unitId, reasonCode: 'unit_credit' }
        : null;
    });
    this.items.register({
      type: 'invoice',
      group: null,
      search: (tx, q, take) => this.findInvoices(tx, q, take),
    });
  }

  private async disputes(
    tx: TenantTxClient,
    q: PageRequest,
    invoiceNumber: number | null,
  ): Promise<ResidentItem[]> {
    const units = await this.community.financeUnits(tx, this.ctx.accountId);
    if (!units.length) return [];
    const conds: Prisma.Sql[] = [
      Prisma.sql`d.unit_id IN (${Prisma.join(units.map((u) => Prisma.sql`${u}::uuid`))})`,
    ];
    if (q.state === 'open') conds.push(Prisma.sql`d.status = 'open'`);
    if (q.state === 'closed') conds.push(Prisma.sql`d.status <> 'open'`);
    if (invoiceNumber !== null)
      conds.push(Prisma.sql`i.number = ${invoiceNumber}`);
    const at = Prisma.sql`GREATEST(d.created_at,
      COALESCE(d.decided_at, d.created_at),
      COALESCE(d.board_appeal_at, d.created_at),
      COALESCE(d.board_appeal_closed_at, d.created_at))`;
    const past = q.after
      ? Prisma.sql`(${at}, d.id) < (${q.after.at}, ${q.after.id}::uuid)`
      : Prisma.sql`TRUE`;
    const rows = await tx.$queryRaw<
      {
        id: string;
        status: string;
        unit_id: string;
        number: number;
        at: Date;
      }[]
    >`
      SELECT d.id, d.status::text AS status, d.unit_id, i.number, ${at} AS at
        FROM invoice_disputes d
        JOIN invoices i ON i.id = d.invoice_id
       WHERE ${Prisma.join(conds, ' AND ')} AND ${past}
       ORDER BY at DESC, d.id DESC
       LIMIT ${q.take}`;
    return rows.map((r) => ({
      type: 'invoice_dispute',
      id: r.id,
      number: formatNumber('invoice', r.number),
      status: r.status,
      lastActivityAt: r.at,
      unitId: r.unit_id,
      kind: null,
      categoryKey: null,
      topicKey: null,
      requestType: null,
      appeal: null,
    }));
  }

  private async findInvoices(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
  ): Promise<ResidentItem[]> {
    if (!wantsNumber(q, 'INV')) return [];
    const units = await this.community.financeUnits(tx, this.ctx.accountId);
    if (!units.length) return [];
    const found = await tx.invoice.findMany({
      where: { unitId: { in: units }, number: q.number! },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    if (!found.length) return [];
    const views = await this.invoices.views(
      tx,
      found,
      await this.invoices.today(tx),
    );
    return views.map((v) => ({
      type: 'invoice',
      id: v.id,
      number: v.number,
      status: v.status,
      lastActivityAt: v.createdAt,
      unitId: v.unitId,
      kind: v.kind,
      categoryKey: null,
      topicKey: null,
      requestType: null,
      appeal: null,
    }));
  }
}
