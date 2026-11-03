import { Injectable } from '@nestjs/common';
import type { Ticket, TicketVendorDispatch } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';
import { DispatchEngine } from '../dispatch/dispatch-engine';
import { TicketAccess, ticketNotFound } from '../tickets/ticket-access';
import { TicketLog } from '../tickets/ticket-log';
import { TicketNotices } from '../tickets/ticket-notices';
import { assertCan, ticketNumber } from '../tickets/ticket-rules';
import { residentReporter } from '../tickets/ticket-visibility';
import { VendorsService } from '../vendors/vendors.service';
import { ContractorAccess, contractorsOf } from './contractor-access';

/** An offer as the contractor's app lists it: the work, never a resident. */
export interface OfferRead {
  dispatch: TicketVendorDispatch;
  ticket: Pick<
    Ticket,
    | 'id'
    | 'number'
    | 'priority'
    | 'status'
    | 'commonArea'
    | 'unitId'
    | 'createdAt'
  >;
  categoryKey: string;
}

const PAGE = keysetCursor('offeredAt');

export const dispatchNotFound = () =>
  appError.notFound(
    ErrorCode.VENDOR_DISPATCH_NOT_FOUND,
    'This offer does not exist',
  );
const dispatchState = (status: string) =>
  appError.conflict(
    ErrorCode.VENDOR_DISPATCH_STATE,
    'This offer was decided or taken back already',
    { params: { status } },
  );

/**
 * A ticket dispatched to a vendor (ADR 0088). Dispatch (`tickets.dispatch`)
 * offers a queued ticket with no technician to a vendor of the register
 * that has a contractor who can take it; the ticket stays in the queue,
 * out of the dispatch engine's reach, its SLA clock running as before.
 * The vendor's contractors see the offer — the work, never a resident —
 * and one of them takes it: it becomes the ticket's technician and works
 * it through the technician's routes, seeing exactly what a technician on
 * that job sees. Or one turns it down with a reason, or dispatch takes it
 * back: the ticket is the queue's again. Every later path by which the
 * contractor loses it lets the vendor go too (a trigger).
 *
 * Locks: the caller's account (shared) → the vendor (shared: not
 * suspended meanwhile) → the ticket (update). Every write of an offer
 * holds its ticket's lock, so two contractors taking one offer, or a
 * contractor and dispatch at once, are one after the other.
 */
@Injectable()
export class VendorDispatchService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly contractor: ContractorAccess,
    private readonly vendors: VendorsService,
    private readonly log: TicketLog,
    private readonly notices: TicketNotices,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly engine: DispatchEngine,
  ) {}

  // --------------------------------------------------------------------------
  // Dispatch
  // --------------------------------------------------------------------------

  offer(
    ticketId: string,
    input: { vendorId: string; note?: string },
  ): Promise<TicketVendorDispatch> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.vendors.lockUsable(tx, input.vendorId);
      const ticket = await this.access.load(tx, ticketId, 'dispatch', {
        lock: true,
      });
      assertCan(ticket, 'assign');
      if (ticket.vendorId !== null)
        throw appError.conflict(
          ErrorCode.TICKET_OFFERED_TO_VENDOR,
          'The ticket is offered to a vendor',
          { params: { vendorId: ticket.vendorId } },
        );
      const crew = await contractorsOf(
        tx,
        input.vendorId,
        'tickets.contract_work',
      );
      if (!crew.length)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'The vendor has no contractor who can take it',
          {
            fields: [
              {
                field: 'vendorId',
                code: FieldErrorCode.INVALID_VALUE,
                params: { reason: 'no_contractor' },
              },
            ],
          },
        );
      const now = await dbNow(tx);
      const dispatch = await tx.ticketVendorDispatch.create({
        data: {
          id: newId(),
          tenantId: ticket.tenantId,
          ticketId,
          vendorId: input.vendorId,
          cycle: ticket.cycle,
          note: input.note?.trim() || null,
          offeredById: me,
          offeredAt: now,
        },
      });
      await tx.ticket.update({
        where: { id: ticketId },
        data: { vendorId: input.vendorId },
      });
      await this.audit.record(tx, {
        action: 'vendor_dispatch.offered',
        targetId: dispatch.id,
        changes: diffChanges(
          null,
          { note: dispatch.note },
          'vendor_dispatch.offered',
        ),
        metadata: {
          ticketId,
          vendorId: input.vendorId,
          cycle: ticket.cycle,
          priority: ticket.priority,
        },
      });
      const category = await tx.ticketCategory.findUniqueOrThrow({
        where: { id: ticket.categoryId },
        select: { key: true },
      });
      await this.notifier.notify(tx, crew, {
        kind: 'vendor_dispatch.offered',
        params: {
          ticketNumber: ticketNumber(ticket.number),
          priority: ticket.priority,
          categoryKey: category.key,
        },
        targetId: dispatch.id,
      });
      return dispatch;
    });
  }

  /** Taken back while it is offered: the ticket is the queue's again. */
  async withdraw(ticketId: string, reasonCode?: string): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.vendorDispatchWithdraw,
    );
    const me = this.ctx.accountId;
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'dispatch', {
        lock: true,
      });
      const live = await this.live(tx, ticketId);
      if (!live) throw dispatchNotFound();
      if (live.status !== 'offered') throw dispatchState(live.status);
      const now = await dbNow(tx);
      await tx.ticketVendorDispatch.update({
        where: { id: live.id },
        data: {
          status: 'withdrawn',
          withdrawnById: me,
          withdrawReason: code,
          endedAt: now,
        },
      });
      await tx.ticket.update({
        where: { id: ticketId },
        data: { vendorId: null },
      });
      await this.audit.record(tx, {
        action: 'vendor_dispatch.withdrawn',
        targetId: live.id,
        metadata: { ticketId, vendorId: live.vendorId, reasonCode: code },
      });
      await this.notifier.notify(
        tx,
        await contractorsOf(tx, live.vendorId, 'tickets.contract_work'),
        {
          kind: 'vendor_dispatch.withdrawn',
          params: { ticketNumber: ticketNumber(ticket.number) },
          targetId: live.id,
        },
      );
    });
    // Back in the queue: the engine may give it to staff now (ADR 0033).
    await this.engine.dispatch([ticketId], 'released');
  }

  /** A ticket's offers, oldest first (dispatch's view). */
  ofTicket(ticketId: string): Promise<TicketVendorDispatch[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, ticketId, 'dispatch');
      return tx.ticketVendorDispatch.findMany({
        where: { ticketId },
        orderBy: [{ offeredAt: 'asc' }, { id: 'asc' }],
      });
    });
  }

  // --------------------------------------------------------------------------
  // The vendor's contractors
  // --------------------------------------------------------------------------

  /** The vendor's offers, newest first; `open` keeps those still offered. */
  offers(q: {
    open?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<OfferRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const vendorId = await this.contractor.vendorOf(tx);
      const rows = await tx.ticketVendorDispatch.findMany({
        where: {
          AND: [
            { vendorId },
            q.open ? { status: 'offered' } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.reads(tx, page.items) };
    });
  }

  /**
   * Taken: the contractor becomes the ticket's technician (status
   * `assigned`), as a dispatcher's assignment would make them. Two
   * contractors at once: one takes it, the other is told it was.
   */
  async accept(dispatchId: string): Promise<{ ticketId: string }> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { vendorId } = await this.contractor.lockSelf(tx);
      const found = await this.mine(tx, dispatchId, vendorId);
      await this.vendors.lockUsable(tx, vendorId);
      const ticket = await this.lockTicket(tx, found.ticketId);
      const live = await tx.ticketVendorDispatch.findUniqueOrThrow({
        where: { id: dispatchId },
      });
      if (live.status !== 'offered') throw dispatchState(live.status);
      // The offer is live, so its ticket is queued with no technician and
      // this vendor's (the trigger keeps the three together).
      assertCan(ticket, 'assign');
      const now = await dbNow(tx);
      await tx.ticketVendorDispatch.update({
        where: { id: dispatchId },
        data: { status: 'accepted', decidedById: me, decidedAt: now },
      });
      await tx.ticket.update({
        where: { id: ticket.id },
        data: { status: 'assigned', technicianId: me, assignedAt: now },
      });
      await this.log.assignment(tx, ticket, {
        type: 'vendor',
        fromId: null,
        toId: me,
        assignedById: me,
        cycle: ticket.cycle,
      });
      await this.log.status(tx, ticket, {
        from: ticket.status,
        to: 'assigned',
        actorId: me,
        cycle: ticket.cycle,
      });
      await this.audit.record(tx, {
        action: 'vendor_dispatch.accepted',
        targetId: dispatchId,
        metadata: { ticketId: ticket.id, vendorId, cycle: ticket.cycle },
      });
      await this.notices.sendBare(
        tx,
        [live.offeredById],
        'vendor_dispatch.decided',
        ticket,
        { decision: 'accepted' },
      );
      await this.notices.send(
        tx,
        [residentReporter(ticket)],
        'ticket.status_changed',
        ticket,
        { status: 'assigned' },
        me,
      );
      return { ticketId: ticket.id };
    });
  }

  /** Turned down with a reason: the ticket is the queue's again. */
  async decline(dispatchId: string, reasonCode?: string): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.vendorDispatchDecline,
    );
    const me = this.ctx.accountId;
    const ticketId = await this.tenantTx.withTenantTx(async (tx) => {
      const { vendorId } = await this.contractor.lockSelf(tx);
      const found = await this.mine(tx, dispatchId, vendorId);
      const ticket = await this.lockTicket(tx, found.ticketId);
      const live = await tx.ticketVendorDispatch.findUniqueOrThrow({
        where: { id: dispatchId },
      });
      if (live.status !== 'offered') throw dispatchState(live.status);
      const now = await dbNow(tx);
      await tx.ticketVendorDispatch.update({
        where: { id: dispatchId },
        data: {
          status: 'declined',
          decidedById: me,
          decidedAt: now,
          declineReason: code,
        },
      });
      await tx.ticket.update({
        where: { id: ticket.id },
        data: { vendorId: null },
      });
      await this.audit.record(tx, {
        action: 'vendor_dispatch.declined',
        targetId: dispatchId,
        metadata: { ticketId: ticket.id, vendorId, reasonCode: code },
      });
      await this.notices.sendBare(
        tx,
        [live.offeredById],
        'vendor_dispatch.decided',
        ticket,
        { decision: 'declined' },
      );
      return ticket.id;
    });
    await this.engine.dispatch([ticketId], 'declined');
  }

  // --------------------------------------------------------------------------

  private live(
    tx: TenantTxClient,
    ticketId: string,
  ): Promise<TicketVendorDispatch | null> {
    return tx.ticketVendorDispatch.findFirst({
      where: { ticketId, status: { in: ['offered', 'accepted'] } },
    });
  }

  /** The caller's vendor's offer, or one 404 for anyone else's. */
  private async mine(
    tx: TenantTxClient,
    dispatchId: string,
    vendorId: string,
  ): Promise<TicketVendorDispatch> {
    const d = await tx.ticketVendorDispatch.findUnique({
      where: { id: dispatchId },
    });
    if (!d || d.vendorId !== vendorId) throw dispatchNotFound();
    return d;
  }

  private async lockTicket(tx: TenantTxClient, id: string): Promise<Ticket> {
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id}::uuid FOR UPDATE`;
    const ticket = await tx.ticket.findUnique({ where: { id } });
    if (!ticket) throw ticketNotFound();
    return ticket;
  }

  private async reads(
    tx: TenantTxClient,
    rows: readonly TicketVendorDispatch[],
  ): Promise<OfferRead[]> {
    const tickets = new Map(
      (
        await tx.ticket.findMany({
          where: { id: { in: rows.map((r) => r.ticketId) } },
          select: {
            id: true,
            number: true,
            priority: true,
            status: true,
            commonArea: true,
            unitId: true,
            createdAt: true,
            categoryId: true,
          },
        })
      ).map((t) => [t.id, t]),
    );
    const categories = new Map(
      (
        await tx.ticketCategory.findMany({
          where: {
            id: { in: [...tickets.values()].map((t) => t.categoryId) },
          },
          select: { id: true, key: true },
        })
      ).map((c) => [c.id, c.key]),
    );
    return rows.map((d) => {
      const { categoryId, ...ticket } = tickets.get(d.ticketId)!;
      return {
        dispatch: d,
        ticket,
        categoryKey: categories.get(categoryId)!,
      };
    });
  }
}
