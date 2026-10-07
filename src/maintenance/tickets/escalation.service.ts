import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Ticket, TicketEscalation } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SlaRecorder } from '../sla/sla-recorder';
import { SlaService, type SlaSummary } from '../sla/sla.service';
import { escalationRefusal, type EscalationRefusal } from './escalation-rules';
import { TicketAccess } from './ticket-access';
import { TicketNotices } from './ticket-notices';

export const ESCALATION_RESOURCE = 'ticket_escalation';

/** What a resident's view says of the escalation (ADR 0038). */
export interface EscalationState {
  /** This SLA cycle's escalation, or null. */
  escalatedAt: Date | null;
  /** The caller may escalate now: the endpoint's own rules. */
  canEscalate: boolean;
}

type EscalationTicket = Pick<Ticket, 'id' | 'status' | 'holdReason' | 'unitId'>;

/**
 * Resident escalation (ADR 0038): a resident asks for attention on a
 * ticket whose SLA commitment is late and still unmet. Once per SLA cycle.
 * It tells the dispatchers and managers and changes nothing else: not the
 * priority, the technician, the status or the clocks.
 */
@Injectable()
export class EscalationService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly recorder: SlaRecorder,
    private readonly sla: SlaService,
    private readonly notices: TicketNotices,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    // The answer has no body: a replay renders nothing.
    this.idempotency.renderer(ESCALATION_RESOURCE, () =>
      Promise.resolve(undefined),
    );
  }

  /**
   * Under the ticket's lock: clocks already past due are breached at their
   * due time first (time decides, not the sweep), then the rules.
   */
  escalate(id: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const escalationId = newId();
      await this.idempotency.claim(tx, {
        type: ESCALATION_RESOURCE,
        id: escalationId,
      });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, id, 'resident', {
        lock: true,
      });
      await this.recorder.settle(tx, ticket);
      const sla = await this.sla.summary(tx, ticket);
      const [state] = await this.facts(tx, [ticket], new Map([[id, sla]]));
      const refusal = escalationRefusal(state);
      if (refusal) throw refused(refusal, ticket);
      await tx.ticketEscalation.create({
        data: {
          id: escalationId,
          tenantId: ticket.tenantId,
          ticketId: ticket.id,
          slaCycle: sla!.cycle,
          accountId: me,
        },
      });
      await this.audit.record(tx, {
        action: 'ticket.escalated_by_resident',
        targetId: ticket.id,
        metadata: { slaCycle: sla!.cycle, clocks: sla!.overdueClocks },
      });
      await this.notices.sendBare(
        tx,
        [
          ...(await this.notices.holding(tx, 'tickets.dispatch')),
          ...(await this.notices.holding(tx, 'maintenance.manage')),
        ],
        ticket.priority === 'emergency'
          ? 'ticket.resident_escalated_emergency'
          : 'ticket.resident_escalated',
        ticket,
      );
    });
  }

  /**
   * What the caller's views say of each ticket, in a fixed number of
   * queries for the page: this cycle's escalations in one, and the
   * caller's `tickets` once per distinct unit.
   */
  async states(
    tx: TenantTxClient,
    tickets: readonly EscalationTicket[],
    slas: ReadonlyMap<string, SlaSummary | null>,
  ): Promise<Map<string, EscalationState>> {
    const facts = await this.facts(tx, tickets, slas);
    return new Map(
      facts.map((f) => [
        f.ticketId,
        {
          escalatedAt: f.escalatedAt,
          canEscalate: escalationRefusal(f) === null,
        },
      ]),
    );
  }

  /** Dispatch: every escalation of the ticket, oldest first. */
  list(tx: TenantTxClient, ticketId: string): Promise<TicketEscalation[]> {
    return tx.ticketEscalation.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async facts(
    tx: TenantTxClient,
    tickets: readonly EscalationTicket[],
    slas: ReadonlyMap<string, SlaSummary | null>,
  ) {
    const me = this.ctx.accountId;
    const measured = tickets.filter((t) => slas.get(t.id));
    const rows = measured.length
      ? await tx.ticketEscalation.findMany({
          where: { ticketId: { in: measured.map((t) => t.id) } },
        })
      : [];
    const mayAct = new Map<string | null, boolean>();
    for (const unitId of new Set(tickets.map((t) => t.unitId)))
      mayAct.set(unitId, await this.access.mayOpen(tx, unitId, me));
    return tickets.map((t) => {
      const sla = slas.get(t.id) ?? null;
      const mine = sla
        ? rows.find((r) => r.ticketId === t.id && r.slaCycle === sla.cycle)
        : undefined;
      return {
        ticketId: t.id,
        status: t.status,
        holdReason: t.holdReason,
        overdue: sla?.overdueClocks ?? [],
        escalated: mine !== undefined,
        escalatedAt: mine?.createdAt ?? null,
        mayAct: mayAct.get(t.unitId)!,
      };
    });
  }
}

function refused(refusal: EscalationRefusal, ticket: Pick<Ticket, 'status'>) {
  switch (refusal) {
    case 'not_allowed':
      return appError.forbidden(
        ErrorCode.TICKETS_NOT_ALLOWED,
        'Tickets are not allowed here',
      );
    case 'status':
      return appError.conflict(
        ErrorCode.TICKET_INVALID_TRANSITION,
        `A ${ticket.status} ticket does not allow escalate`,
        { params: { status: ticket.status } },
      );
    case 'not_overdue':
      return appError.conflict(
        ErrorCode.TICKET_NOT_OVERDUE,
        'No commitment of this ticket is overdue',
      );
    case 'already_escalated':
      return appError.conflict(
        ErrorCode.TICKET_ALREADY_ESCALATED,
        'This ticket was already escalated',
      );
  }
}
