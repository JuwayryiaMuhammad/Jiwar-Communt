import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma, Ticket, TicketCostEntry } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { TicketAccess } from '../tickets/ticket-access';
import {
  costAmount,
  costTotals,
  type CostTotals,
  type RecordedCostKind,
} from './cost-rules';

export const TICKET_COST_RESOURCE = 'ticket_cost_entry';
/** Entries a ticket holds at most, voided ones included: one bounded list. */
export const TICKET_COST_MAX = 200;

export interface RecordedCost {
  kind: RecordedCostKind;
  description: string;
  quantity: string;
  unitAmount: string;
}

/** A part the store issued (positive) or took back (negative) for a ticket. */
export interface PartCost {
  ticket: Pick<Ticket, 'id' | 'tenantId'>;
  itemId: string;
  movementId: string;
  quantity: Prisma.Decimal;
  unitAmount: Prisma.Decimal;
  actorId: string | null;
  at: Date;
}

export interface TicketCosts {
  entries: TicketCostEntry[];
  totals: CostTotals;
}

const entryNotFound = () =>
  appError.notFound(
    ErrorCode.TICKET_COST_ENTRY_NOT_FOUND,
    'Cost entry not found',
  );

/**
 * What a job cost (ADR 0065). Dispatch records labour, a contractor and
 * other costs by hand and voids an entry once, with a reason; the store
 * writes a part's entry as it issues or takes back the part, at the item's
 * average cost then, and only a return undoes it. Asset economics and the
 * KPIs read these entries; nothing here is a resident's to see.
 *
 * Lock order: the caller's account (shared), then the ticket (`FOR
 * UPDATE`), then the entry. Times are the database's.
 */
@Injectable()
export class TicketCostsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(TICKET_COST_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const entry = await tx.ticketCostEntry.findUnique({ where: { id } });
        if (!entry) throw entryNotFound();
        return entry;
      }),
    );
  }

  /** A ticket's entries, oldest first, with what they add up to. */
  list(ticketId: string): Promise<TicketCosts> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, ticketId, 'dispatch');
      return this.of(tx, ticketId);
    });
  }

  async of(tx: TenantTxClient, ticketId: string): Promise<TicketCosts> {
    const entries = await tx.ticketCostEntry.findMany({
      where: { ticketId },
      orderBy: [{ enteredAt: 'asc' }, { id: 'asc' }],
      take: TICKET_COST_MAX + 100,
    });
    return { entries, totals: costTotals(entries) };
  }

  /** Dispatch: labour, a contractor or another cost, on any ticket. */
  record(ticketId: string, input: RecordedCost): Promise<TicketCostEntry> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: TICKET_COST_RESOURCE, id });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'dispatch', {
        lock: true,
      });
      await this.requireRoom(tx, ticket.id);
      const entry = await tx.ticketCostEntry.create({
        data: {
          id,
          tenantId: ticket.tenantId,
          ticketId: ticket.id,
          kind: input.kind,
          description: input.description.trim(),
          quantity: input.quantity,
          unitAmount: input.unitAmount,
          amount: costAmount(input.quantity, input.unitAmount),
          enteredById: me,
          enteredAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'ticket_cost.recorded',
        targetId: id,
        changes: diffChanges(
          null,
          {
            ticketId: ticket.id,
            kind: entry.kind,
            description: entry.description,
            quantity: entry.quantity.toFixed(3),
            unitAmount: entry.unitAmount.toFixed(2),
            amount: entry.amount.toFixed(2),
          },
          'ticket_cost.recorded',
        ),
      });
      return entry;
    });
  }

  /** Dispatch: an entry recorded by hand, voided once with a reason. */
  void(entryId: string, reasonCode?: string): Promise<TicketCostEntry> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.ticketCostVoid,
    );
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.ticketCostEntry.findUnique({
        where: { id: entryId },
        select: { ticketId: true },
      });
      if (!seen) throw entryNotFound();
      await this.access.load(tx, seen.ticketId, 'dispatch', { lock: true });
      await tx.$queryRaw`SELECT id FROM ticket_cost_entries WHERE id = ${entryId}::uuid FOR UPDATE`;
      const entry = await tx.ticketCostEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      if (entry.kind === 'part')
        throw appError.conflict(
          ErrorCode.TICKET_COST_ENTRY_IS_PART,
          'A part’s cost is undone by returning the part',
        );
      if (entry.voidedAt)
        throw appError.conflict(
          ErrorCode.TICKET_COST_ENTRY_VOIDED,
          'This entry is voided already',
        );
      const voided = await tx.ticketCostEntry.update({
        where: { id: entryId },
        data: {
          voidedAt: await dbNow(tx),
          voidedById: me,
          voidReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'ticket_cost.voided',
        targetId: entryId,
        metadata: { ticketId: entry.ticketId, reasonCode: reason },
      });
      return voided;
    });
  }

  /**
   * The store's entry for a part it issued or took back, in its
   * transaction, under the ticket's lock it holds. Not audited apart: the
   * movement's audit row says it.
   */
  async part(tx: TenantTxClient, p: PartCost): Promise<TicketCostEntry> {
    await this.requireRoom(tx, p.ticket.id);
    return tx.ticketCostEntry.create({
      data: {
        id: newId(),
        tenantId: p.ticket.tenantId,
        ticketId: p.ticket.id,
        kind: 'part',
        description: null,
        quantity: p.quantity,
        unitAmount: p.unitAmount,
        amount: costAmount(p.quantity, p.unitAmount),
        itemId: p.itemId,
        movementId: p.movementId,
        enteredById: p.actorId,
        enteredAt: p.at,
      },
    });
  }

  private async requireRoom(tx: TenantTxClient, ticketId: string) {
    if (
      (await tx.ticketCostEntry.count({ where: { ticketId } })) >=
      TICKET_COST_MAX
    )
      throw appError.conflict(
        ErrorCode.TICKET_COST_LIMIT_REACHED,
        'This ticket holds as many cost entries as it may',
        { params: { max: TICKET_COST_MAX } },
      );
  }
}
