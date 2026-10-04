import { Injectable } from '@nestjs/common';
import type { TicketPriority } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TicketAccess } from './ticket-access';
import { TicketLog } from './ticket-log';
import { TicketNotices } from './ticket-notices';
import { assertCan, IN_HAND } from './ticket-rules';

export interface TechnicianOption {
  id: string;
  fullName: string | null;
  openTickets: number;
  /** Their active specialties (ADR 0033). */
  specialties: { id: string; key: string }[];
}

const sameAsCurrent = (field: string) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Nothing changes', {
    fields: [{ field, code: FieldErrorCode.SAME_AS_CURRENT }],
  });

/**
 * Manual dispatch (ADR 0032), for `tickets.dispatch`: assign a ticket from
 * the queue, reassign it with a reason, change its priority with a reason.
 * The dispatch engine (Phase 5.2) will write `automatic` assignments next
 * to these.
 *
 * Every write locks the target technician's account row first (FOR SHARE)
 * and then the ticket (FOR UPDATE), the same order as the deactivation
 * hook, which updates the account and then releases its tickets: an
 * assignment never lands on a technician whose deactivation is committing.
 */
@Injectable()
export class DispatchService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly log: TicketLog,
    private readonly notices: TicketNotices,
    private readonly audit: AuditService,
  ) {}

  /** Who can take tickets: active staff holding tickets.work. */
  technicians(): Promise<TechnicianOption[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.account.findMany({
        where: {
          status: 'active',
          type: 'staff',
          role: { permissions: { some: { permission: 'tickets.work' } } },
        },
        select: { id: true, fullName: true },
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      });
      const open = await tx.ticket.groupBy({
        by: ['technicianId'],
        where: {
          technicianId: { in: rows.map((r) => r.id) },
          status: { in: [...IN_HAND] },
        },
        _count: { _all: true },
      });
      const counts = new Map(open.map((o) => [o.technicianId, o._count._all]));
      const links = await tx.technicianSpecialty.findMany({
        where: {
          accountId: { in: rows.map((r) => r.id) },
          active: true,
          specialty: { active: true },
        },
        select: {
          accountId: true,
          specialty: { select: { id: true, key: true } },
        },
        orderBy: [{ specialty: { key: 'asc' } }],
      });
      return rows.map((r) => ({
        ...r,
        openTickets: counts.get(r.id) ?? 0,
        specialties: links
          .filter((l) => l.accountId === r.id)
          .map((l) => l.specialty),
      }));
    });
  }

  /** From the queue to a technician. Two dispatchers at once: one wins. */
  assign(id: string, technicianId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockTechnician(tx, technicianId);
      const ticket = await this.access.load(tx, id, 'dispatch', { lock: true });
      assertCan(ticket, 'assign');
      const updated = await tx.ticket.update({
        where: { id },
        data: {
          status: 'assigned',
          technicianId,
          assignedAt: new Date(),
        },
      });
      await this.log.assignment(tx, ticket, {
        type: 'manual',
        fromId: null,
        toId: technicianId,
        assignedById: me,
        cycle: ticket.cycle,
      });
      await this.log.status(tx, ticket, {
        from: ticket.status,
        to: 'assigned',
        actorId: me,
        cycle: ticket.cycle,
      });
      await this.assigned(tx, updated, technicianId);
      await this.notices.send(
        tx,
        [ticket.reporterId],
        'ticket.status_changed',
        ticket,
        { status: 'assigned' },
        me,
      );
    });
  }

  /**
   * To another technician, with a reason. The ticket goes back to
   * `assigned`: the new technician starts the work. The old one loses the
   * ticket at once and is told.
   */
  reassign(id: string, technicianId: string, reasonCode?: string) {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.ticketReassign);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockTechnician(tx, technicianId);
      const ticket = await this.access.load(tx, id, 'dispatch', { lock: true });
      assertCan(ticket, 'reassign');
      if (ticket.technicianId === technicianId)
        throw sameAsCurrent('technicianId');
      const updated = await tx.ticket.update({
        where: { id },
        data: {
          status: 'assigned',
          holdReason: null,
          technicianId,
          assignedAt: new Date(),
        },
      });
      await this.log.assignment(tx, ticket, {
        type: 'reassignment',
        fromId: ticket.technicianId,
        toId: technicianId,
        assignedById: me,
        reasonCode: code,
        cycle: ticket.cycle,
      });
      await this.log.status(tx, ticket, {
        from: ticket.status,
        to: 'assigned',
        actorId: me,
        reasonCode: code,
        cycle: ticket.cycle,
      });
      await this.assigned(tx, updated, technicianId);
      await this.notices.send(
        tx,
        [ticket.technicianId],
        'ticket.unassigned',
        ticket,
        {},
        me,
      );
      if (ticket.status !== 'assigned')
        await this.notices.send(
          tx,
          [ticket.reporterId],
          'ticket.status_changed',
          ticket,
          { status: 'assigned' },
          me,
        );
    });
  }

  /**
   * A dispatcher's judgement over the reporter's, with a reason (audited).
   * Raised to emergency, every dispatcher is told critically.
   */
  changePriority(id: string, priority: TicketPriority, reasonCode?: string) {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.ticketPriority);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, id, 'dispatch', { lock: true });
      assertCan(ticket, 'changePriority');
      if (ticket.priority === priority) throw sameAsCurrent('priority');
      await tx.ticket.update({ where: { id }, data: { priority } });
      await this.audit.record(tx, {
        action: 'ticket.priority_changed',
        targetId: id,
        changes: { priority: { from: ticket.priority, to: priority } },
        metadata: { reasonCode: code },
      });
      if (priority === 'emergency') {
        const category = await tx.ticketCategory.findUniqueOrThrow({
          where: { id: ticket.categoryId },
        });
        await this.notices.send(
          tx,
          await this.notices.dispatchers(tx),
          'ticket.emergency',
          ticket,
          { categoryKey: category.key },
          me,
        );
      }
      await this.notices.send(
        tx,
        [ticket.technicianId],
        'ticket.priority_changed',
        ticket,
        { priority },
        me,
      );
    });
  }

  private async assigned(
    tx: TenantTxClient,
    ticket: {
      id: string;
      number: number;
      unitId: string | null;
      priority: TicketPriority;
      categoryId: string;
    },
    technicianId: string,
  ): Promise<void> {
    const category = await tx.ticketCategory.findUniqueOrThrow({
      where: { id: ticket.categoryId },
    });
    await this.notices.send(tx, [technicianId], 'ticket.assigned', ticket, {
      priority: ticket.priority,
      categoryKey: category.key,
    });
  }
}
