import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type PartRequest,
  type StockItem,
  type Ticket,
} from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TicketCostsService } from '../costs/ticket-costs.service';
import { dbNow } from '../db-clock';
import { ConfirmationService } from '../tickets/confirmation.service';
import { TicketAccess, type Audience } from '../tickets/ticket-access';
import { TicketNotices } from '../tickets/ticket-notices';
import { IN_HAND } from '../tickets/ticket-rules';
import { itemNotFound, StockLedger } from './stock-ledger';
import { OPEN_PART_REQUESTS, qty, type PartRequestStatus } from './stock-rules';

export const PART_REQUEST_RESOURCE = 'part_request';
export const PART_RETURN_RESOURCE = 'part_return';
/** A ticket's requests listed at most. */
export const TICKET_PART_REQUESTS_SHOWN = 100;

/** What a ticket got of an item, net of returns. */
export interface TicketPart {
  itemId: string;
  sku: string;
  issued: Prisma.Decimal;
  returned: Prisma.Decimal;
}

export interface TicketParts {
  requests: PartRequest[];
  parts: TicketPart[];
}

const ZERO = new Prisma.Decimal(0);
/** A return goes back while the ticket is in hand or just completed. */
const RETURNABLE: readonly Ticket['status'][] = [...IN_HAND, 'completed'];
const QUEUE = keysetCursor('requestedAt', 'asc');

const requestNotFound = () =>
  appError.notFound(ErrorCode.PART_REQUEST_NOT_FOUND, 'Part request not found');
const wrongStatus = (status: string) =>
  appError.conflict(
    ErrorCode.PART_REQUEST_WRONG_STATUS,
    'This part request cannot do that now',
    { params: { status } },
  );
const notTakingParts = (status: string) =>
  appError.conflict(
    ErrorCode.TICKET_NOT_TAKING_PARTS,
    'Parts go to a ticket whose work is in hand',
    { params: { status } },
  );

/**
 * A technician's parts for their ticket (ADR 0065). They ask for an item
 * while the work is in hand; who keeps the store (`stock.manage`) reserves
 * it in a store — held there, not free to anyone else — and issues it, or
 * declines; the technician calls off what they no longer need, and returns
 * what they did not use. An issue writes the ticket's part cost at the
 * item's average cost; a return writes it back at what was issued. A
 * cancelled ticket's open requests are called off with it.
 *
 * Lock order: the caller's account (shared), the ticket (`FOR UPDATE`),
 * the request, then the item and its levels through the ledger. Every
 * decision reads the request after its lock: two decisions in a race leave
 * one. Times are the database's.
 */
@Injectable()
export class PartRequestsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly ledger: StockLedger,
    private readonly costs: TicketCostsService,
    private readonly notices: TicketNotices,
    private readonly staff: StaffRecipients,
    private readonly confirmation: ConfirmationService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PART_REQUEST_RESOURCE, (id) => this.get(id));
    this.idempotency.renderer(PART_RETURN_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) =>
        tx.stockMovement.findUniqueOrThrow({ where: { id } }),
      ),
    );
    this.confirmation.onCancelling((tx, ticket) => this.cancelOpen(tx, ticket));
  }

  get(id: string): Promise<PartRequest> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const r = await tx.partRequest.findUnique({ where: { id } });
      if (!r) throw requestNotFound();
      return r;
    });
  }

  /** The store's queue: by status, oldest first. */
  queue(q: {
    status?: PartRequestStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<PartRequest>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.partRequest.findMany({
        where: {
          AND: [
            q.status
              ? { status: q.status }
              : { status: { in: [...OPEN_PART_REQUESTS] } },
            ...QUEUE.after(q.cursor),
          ],
        },
        orderBy: QUEUE.orderBy,
        take: limit + 1,
      });
      return QUEUE.toPage(rows, limit);
    });
  }

  /** A ticket's requests and what it got, for its technician or dispatch. */
  ofTicket(
    ticketId: string,
    audience: Extract<Audience, 'technician' | 'dispatch'>,
  ): Promise<TicketParts> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, ticketId, audience);
      const requests = await tx.partRequest.findMany({
        where: { ticketId },
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        take: TICKET_PART_REQUESTS_SHOWN,
      });
      return { requests, parts: await this.parts(tx, ticketId) };
    });
  }

  /** The ticket's technician asks for a part, while the work is in hand. */
  request(
    ticketId: string,
    input: { itemId: string; quantity: string },
  ): Promise<PartRequest> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: PART_REQUEST_RESOURCE, id });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'technician', {
        lock: true,
      });
      if (!IN_HAND.includes(ticket.status)) throw notTakingParts(ticket.status);
      const item = await tx.stockItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw itemNotFound();
      if (!item.active)
        throw appError.conflict(
          ErrorCode.STOCK_ITEM_RETIRED,
          'This item is retired',
        );
      const request = await tx.partRequest.create({
        data: {
          id,
          tenantId: ticket.tenantId,
          ticketId,
          itemId: item.id,
          quantity: input.quantity,
          requestedById: me,
          requestedAt: await dbNow(tx),
        },
      });
      await this.record(tx, 'part_request.requested', request);
      await this.notices.sendBare(
        tx,
        (await this.staff.holding(tx, 'stock.manage')).map((s) => s.id),
        'part_request.created',
        ticket,
        { itemRef: item.sku },
        me,
      );
      return request;
    });
  }

  /** The technician calls off what they no longer need, before it is issued. */
  cancel(requestId: string, reasonCode?: string): Promise<PartRequest> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.partRequestCancel,
    );
    return this.decide(requestId, 'technician', async (tx, _ticket, r) => {
      if (!OPEN_PART_REQUESTS.includes(r.status as PartRequestStatus))
        throw wrongStatus(r.status);
      await this.releaseIfReserved(tx, r);
      return this.close(tx, r, 'cancelled', reason);
    });
  }

  /** The store holds the part in one of its stores for the ticket. */
  reserve(requestId: string, storeId: string): Promise<PartRequest> {
    const me = this.ctx.accountId;
    return this.decide(requestId, 'dispatch', async (tx, ticket, r) => {
      if (r.status !== 'requested') throw wrongStatus(r.status);
      if (!IN_HAND.includes(ticket.status)) throw notTakingParts(ticket.status);
      const item = await this.ledger.lockItem(tx, r.itemId);
      const store = await this.ledger.activeStore(tx, storeId);
      await this.ledger.reserve(tx, item, store.id, r.quantity);
      const reserved = await tx.partRequest.update({
        where: { id: r.id },
        data: {
          status: 'reserved',
          storeId: store.id,
          reservedById: me,
          reservedAt: await dbNow(tx),
        },
      });
      await this.record(tx, 'part_request.reserved', reserved);
      await this.notices.sendBare(
        tx,
        [r.requestedById],
        'part_request.reserved',
        ticket,
        { itemRef: item.sku },
        me,
      );
      return reserved;
    });
  }

  /**
   * Handed over: out of the store's reservation, onto the ticket's costs
   * at the item's average cost now.
   */
  issue(requestId: string): Promise<PartRequest> {
    const me = this.ctx.accountId;
    return this.decide(requestId, 'dispatch', async (tx, ticket, r) => {
      if (r.status !== 'reserved') throw wrongStatus(r.status);
      if (!IN_HAND.includes(ticket.status)) throw notTakingParts(ticket.status);
      const item = await this.ledger.lockItem(tx, r.itemId);
      const store = await this.ledger.shareStore(tx, r.storeId!);
      const movement = await this.ledger.move(tx, {
        item,
        store,
        kind: 'issue',
        quantity: r.quantity.negated(),
        unreserve: r.quantity,
        ticketId: ticket.id,
        partRequestId: r.id,
        actorId: me,
      });
      await this.costs.part(tx, {
        ticket,
        itemId: item.id,
        movementId: movement.id,
        quantity: r.quantity,
        unitAmount: item.averageCost ?? ZERO,
        actorId: me,
        at: movement.occurredAt,
      });
      const issued = await this.close(tx, r, 'issued', null);
      await this.ledger.reorder(tx, item.id);
      return issued;
    });
  }

  /** The store cannot, or will not; a reservation is let go. */
  decline(requestId: string, reasonCode?: string): Promise<PartRequest> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.partRequestDecline,
    );
    const me = this.ctx.accountId;
    return this.decide(requestId, 'dispatch', async (tx, ticket, r) => {
      if (!OPEN_PART_REQUESTS.includes(r.status as PartRequestStatus))
        throw wrongStatus(r.status);
      const item = await this.releaseIfReserved(tx, r);
      const declined = await this.close(tx, r, 'declined', reason);
      await this.notices.sendBare(
        tx,
        [r.requestedById],
        'part_request.declined',
        ticket,
        {
          itemRef: (
            item ??
            (await tx.stockItem.findUniqueOrThrow({ where: { id: r.itemId } }))
          ).sku,
          reason,
        },
        me,
      );
      return declined;
    });
  }

  /**
   * The technician brings back what they did not use: into a store, off
   * the ticket's costs at what it was issued at; never more than the
   * ticket got of it.
   */
  returnPart(
    ticketId: string,
    input: { itemId: string; storeId: string; quantity: string },
  ) {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: PART_RETURN_RESOURCE, id });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'technician', {
        lock: true,
      });
      if (!RETURNABLE.includes(ticket.status))
        throw notTakingParts(ticket.status);
      const item = await this.ledger.lockItem(tx, input.itemId);
      const amount = new Prisma.Decimal(input.quantity);
      const got = (await this.parts(tx, ticketId)).find(
        (p) => p.itemId === item.id,
      );
      const returnable = got ? got.issued.minus(got.returned) : ZERO;
      if (returnable.lt(amount))
        throw appError.conflict(
          ErrorCode.PART_RETURN_EXCEEDS_ISSUED,
          'That is more than was issued to this ticket',
          { params: { returnable: qty(returnable) } },
        );
      const store = await this.ledger.activeStore(tx, input.storeId);
      const movement = await this.ledger.move(tx, {
        id,
        item,
        store,
        kind: 'return',
        quantity: amount,
        ticketId,
        actorId: me,
      });
      await this.costs.part(tx, {
        ticket,
        itemId: item.id,
        movementId: movement.id,
        quantity: amount.negated(),
        unitAmount: await this.issuedAt(tx, ticketId, item.id),
        actorId: me,
        at: movement.occurredAt,
      });
      await this.ledger.reorder(tx, item.id);
      await this.audit.record(tx, {
        action: 'stock.returned',
        targetId: item.id,
        metadata: { ticketId, storeId: store.id, quantity: qty(amount) },
      });
      return movement;
    });
  }

  /**
   * A cancelled ticket's open requests, called off in its transaction
   * under its lock; their reservations let go.
   */
  private async cancelOpen(tx: TenantTxClient, ticket: Ticket): Promise<void> {
    const open = await tx.partRequest.findMany({
      where: {
        ticketId: ticket.id,
        status: { in: [...OPEN_PART_REQUESTS] },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    for (const { id } of open) {
      await tx.$queryRaw`SELECT id FROM part_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const r = await tx.partRequest.findUniqueOrThrow({ where: { id } });
      if (!OPEN_PART_REQUESTS.includes(r.status as PartRequestStatus)) continue;
      await this.releaseIfReserved(tx, r);
      await this.close(tx, r, 'cancelled', 'not_needed');
    }
  }

  /** Account, the ticket (as `audience` sees it), then the request. */
  private decide(
    requestId: string,
    audience: Extract<Audience, 'technician' | 'dispatch'>,
    fn: (
      tx: TenantTxClient,
      ticket: Ticket,
      request: PartRequest,
    ) => Promise<PartRequest>,
  ): Promise<PartRequest> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.partRequest.findUnique({
        where: { id: requestId },
        select: { ticketId: true },
      });
      if (!seen) throw requestNotFound();
      const ticket = await this.access
        .load(tx, seen.ticketId, audience, { lock: true })
        .catch(() => {
          throw requestNotFound();
        });
      await tx.$queryRaw`SELECT id FROM part_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
      const request = await tx.partRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      return fn(tx, ticket, request);
    });
  }

  private async releaseIfReserved(
    tx: TenantTxClient,
    r: PartRequest,
  ): Promise<StockItem | null> {
    if (r.status !== 'reserved') return null;
    const item = await this.ledger.lockItem(tx, r.itemId);
    await this.ledger.release(tx, item, r.storeId!, r.quantity);
    return item;
  }

  private async close(
    tx: TenantTxClient,
    r: PartRequest,
    status: 'issued' | 'declined' | 'cancelled',
    reasonCode: string | null,
  ): Promise<PartRequest> {
    const closed = await tx.partRequest.update({
      where: { id: r.id },
      data: {
        status,
        closedById: this.ctx.accountIdOrNull(),
        closedAt: await dbNow(tx),
        reasonCode,
      },
    });
    await this.record(
      tx,
      status === 'issued'
        ? 'part_request.issued'
        : status === 'declined'
          ? 'part_request.declined'
          : 'part_request.cancelled',
      closed,
    );
    return closed;
  }

  private record(
    tx: TenantTxClient,
    action:
      | 'part_request.requested'
      | 'part_request.reserved'
      | 'part_request.issued'
      | 'part_request.declined'
      | 'part_request.cancelled',
    r: PartRequest,
  ) {
    return this.audit.record(tx, {
      action,
      targetId: r.id,
      metadata: {
        ticketId: r.ticketId,
        itemId: r.itemId,
        quantity: qty(r.quantity),
        ...(r.storeId ? { storeId: r.storeId } : {}),
        ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
      },
    });
  }

  /** What the ticket got of each item, from its movements. */
  private async parts(
    tx: TenantTxClient,
    ticketId: string,
  ): Promise<TicketPart[]> {
    const sums = await tx.stockMovement.groupBy({
      by: ['itemId', 'kind'],
      where: { ticketId, kind: { in: ['issue', 'return'] } },
      _sum: { quantity: true },
    });
    const ids = [...new Set(sums.map((s) => s.itemId))];
    const items = new Map(
      (
        await tx.stockItem.findMany({
          where: { id: { in: ids } },
          select: { id: true, sku: true },
        })
      ).map((i) => [i.id, i.sku]),
    );
    return ids.sort().map((itemId) => {
      const of = (kind: string) =>
        sums.find((s) => s.itemId === itemId && s.kind === kind)?._sum
          .quantity ?? ZERO;
      return {
        itemId,
        sku: items.get(itemId) ?? '',
        issued: of('issue').abs(),
        returned: of('return'),
      };
    });
  }

  /** What one unit of the item cost the ticket as issued, on average. */
  private async issuedAt(
    tx: TenantTxClient,
    ticketId: string,
    itemId: string,
  ): Promise<Prisma.Decimal> {
    const issued = await tx.ticketCostEntry.aggregate({
      where: { ticketId, itemId, kind: 'part', quantity: { gt: 0 } },
      _sum: { quantity: true, amount: true },
    });
    const q = issued._sum.quantity;
    if (!q || q.isZero()) return ZERO;
    return issued._sum
      .amount!.dividedBy(q)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }
}
