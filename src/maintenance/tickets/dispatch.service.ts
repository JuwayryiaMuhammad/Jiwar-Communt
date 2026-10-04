import { Injectable } from '@nestjs/common';
import type { TicketPriority } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  AvailabilityService,
  type AvailabilityRead,
} from '../dispatch/availability.service';
import { DispatchBusyError } from '../dispatch/dispatch-busy';
import { DispatchEngine } from '../dispatch/dispatch-engine';
import { DispatchSettingsService } from '../dispatch/dispatch-settings.service';
import { points, workloads } from '../dispatch/workload';
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
  availability: AvailabilityRead;
  /** Weighted open work, in points (two decimals); see ADR 0033. */
  workload: number;
}

/** What an automatic assignment request did. */
export interface AutoAssignment {
  outcome: 'assigned' | 'no_candidate';
  technician: { id: string; fullName: string | null; status: string } | null;
}

const dispatchBusy = () =>
  appError.serviceUnavailable(
    ErrorCode.DISPATCH_BUSY,
    'Dispatch is busy; try again in a moment',
  );

const sameAsCurrent = (field: string) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Nothing changes', {
    fields: [{ field, code: FieldErrorCode.SAME_AS_CURRENT }],
  });

/**
 * Manual dispatch (ADR 0032), for `tickets.dispatch`: assign a ticket from
 * the queue, reassign it with a reason, change its priority with a reason.
 * The dispatch engine (ADR 0033) writes `automatic` assignments next to
 * these.
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
    private readonly availability: AvailabilityService,
    private readonly engine: DispatchEngine,
    private readonly dispatchSettings: DispatchSettingsService,
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
      const states = await this.availability.readMany(
        tx,
        rows.map((r) => r.id),
      );
      const load = await workloads(
        tx,
        rows.map((r) => r.id),
        await this.dispatchSettings.inTx(tx),
      );
      return rows.map((r) => ({
        ...r,
        availability: states.get(r.id)!,
        workload: points(load.get(r.id)!),
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
      await this.notices.assigned(tx, updated, technicianId);
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
   * Runs the dispatch engine on a queued ticket now (ADR 0033), whether or
   * not automatic dispatch is on: a dispatcher's own request. The ticket
   * goes to the best technician, or stays in the queue with the answer
   * `no_candidate` (the attempt is recorded either way).
   */
  autoAssign(id: string): Promise<AutoAssignment> {
    return this.tenantTx.withTenantTx(async (tx) => {
      // The dispatch lock before the ticket's own (the engine's lock order);
      // a lock held too long is an answer, not a hang.
      await this.engine.serialize(tx).catch((e: unknown) => {
        throw e instanceof DispatchBusyError ? dispatchBusy() : e;
      });
      const ticket = await this.access.load(tx, id, 'dispatch', { lock: true });
      assertCan(ticket, 'assign');
      const result = await this.engine.run(tx, id, 'manual');
      if (result.outcome !== 'assigned')
        return { outcome: 'no_candidate', technician: null };
      const technician = await tx.account.findUniqueOrThrow({
        where: { id: result.technicianId },
        select: { id: true, fullName: true, status: true },
      });
      return { outcome: 'assigned', technician };
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
      await this.notices.assigned(tx, updated, technicianId);
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
}
