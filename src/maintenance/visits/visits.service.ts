import { Injectable } from '@nestjs/common';
import type {
  Ticket,
  TicketVisit,
  TicketVisitEvent,
  VisitEventKind,
  VisitSide,
} from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { MaintenanceSettingsService } from '../settings/maintenance-settings.service';
import { SlaRecorder } from '../sla/sla-recorder';
import type { Audience } from '../tickets/ticket-access';
import { TicketNotices } from '../tickets/ticket-notices';
import { assertCan, can } from '../tickets/ticket-rules';
import { TicketsService, type Person } from '../tickets/tickets.service';
import { WorkService } from '../tickets/work.service';
import { sideOf, VisitAccess } from './visit-access';
import { VisitLog } from './visit-log';
import {
  ACTIVE,
  assertNotStarted,
  assertOtherSide,
  assertVisit,
  assertWindow,
  inArrivalWindow,
} from './visit-rules';
import {
  addDays,
  DEFAULT_SLOT_DAYS,
  freeSlots,
  localDate,
  type LocalDate,
  type Slot,
} from './visit-slots';

export interface Window {
  startsAt: Date;
  endsAt: Date;
}

/** A visit's receiver as its readers may see it (null when no longer valid). */
export interface ReceiverRead {
  kind: 'household' | 'worker';
  id: string;
  fullName: string | null;
}

/** A visit with what its views name. */
export interface VisitRead {
  visit: TicketVisit;
  receiver: ReceiverRead | null;
  people: Map<string, Person>;
}

/** A visit of a unit, for the unit's residents (`/me/units/:id/visits`). */
export interface UnitVisitRead extends VisitRead {
  ticket: Pick<Ticket, 'id' | 'number' | 'status'>;
  category: { id: string; key: string; nameAr: string; nameEn: string };
}

const visitAlreadyActive = () =>
  appError.conflict(
    ErrorCode.VISIT_ALREADY_ACTIVE,
    'The ticket already has an active visit',
  );

/**
 * Visits (ADR 0034): when the technician comes to a unit, agreed by both
 * sides. The technician (or a dispatcher for them) proposes; the other side
 * confirms or counter-proposes; a confirmed window that moves is a new
 * proposal (the old one ends `rescheduled`). The technician marks the
 * arrival within the window (the ticket starts if it had not), then `done`
 * or `no_access` (the ticket waits for the resident).
 *
 * Every write locks the ticket first and checks the rules after the lock,
 * timed by the database's clock read after it; at most one visit per
 * ticket is active (a partial unique index backs the check). The window,
 * consent and receiver are never audited and never in a notification
 * beyond the window itself.
 */
@Injectable()
export class VisitsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: VisitAccess,
    private readonly log: VisitLog,
    private readonly notices: TicketNotices,
    private readonly community: CommunityMaintenancePort,
    private readonly tickets: TicketsService,
    private readonly work: WorkService,
    private readonly sla: SlaRecorder,
    private readonly maintenanceSettings: MaintenanceSettingsService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // --- proposals -----------------------------------------------------------

  /** The technician's side proposes a window (none may be active). */
  propose(
    ticketId: string,
    window: Window,
    audience: 'technician' | 'dispatch',
  ): Promise<TicketVisit> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, audience);
      const now = await dbNow(tx);
      assertWindow(window.startsAt, window.endsAt, now);
      if (await this.active(tx, ticket.id)) throw visitAlreadyActive();
      return this.create(tx, ticket, window, 'technician', null, now);
    });
  }

  /** The other side answers a proposal with another window. */
  counter(
    ticketId: string,
    visitId: string,
    window: Window,
    audience: Audience,
  ): Promise<TicketVisit> {
    const side = sideOf(audience);
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, audience);
      const visit = await this.access.visit(tx, ticket, visitId, audience);
      assertVisit(visit, 'counter');
      assertOtherSide(visit, side);
      const now = await dbNow(tx);
      assertWindow(window.startsAt, window.endsAt, now);
      await this.end(tx, ticket, visit, {
        status: 'rescheduled',
        kind: 'countered',
        side,
        actorId: this.ctx.accountId,
        reasonCode: null,
        now,
      });
      return this.create(tx, ticket, window, side, visit.id, now);
    });
  }

  /** The other side agrees: confirmed. */
  confirm(
    ticketId: string,
    visitId: string,
    audience: Audience,
  ): Promise<void> {
    const side = sideOf(audience);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, audience);
      const visit = await this.access.visit(tx, ticket, visitId, audience);
      assertVisit(visit, 'confirm');
      assertOtherSide(visit, side);
      const now = await dbNow(tx);
      assertNotStarted(visit, now);
      const confirmed = await tx.ticketVisit.update({
        where: { id: visit.id },
        data: { status: 'confirmed', confirmedAt: now, confirmedById: me },
      });
      await this.log.write(tx, visit, {
        kind: 'confirmed',
        side,
        actorId: me,
        at: now,
      });
      await this.tell(
        tx,
        ticket,
        confirmed,
        'ticket.visit_confirmed',
        visit.proposedBySide === 'resident'
          ? await this.residents(tx, ticket)
          : [visit.technicianId],
      );
    });
  }

  /** A confirmed window moves: a new proposal, the old one `rescheduled`. */
  reschedule(
    ticketId: string,
    visitId: string,
    window: Window,
    reasonCode: string | undefined,
    audience: Audience,
  ): Promise<TicketVisit> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.visitChange);
    const side = sideOf(audience);
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, audience);
      const visit = await this.access.visit(tx, ticket, visitId, audience);
      assertVisit(visit, 'reschedule');
      const now = await dbNow(tx);
      assertWindow(window.startsAt, window.endsAt, now);
      await this.end(tx, ticket, visit, {
        status: 'rescheduled',
        kind: 'rescheduled',
        side,
        actorId: this.ctx.accountId,
        reasonCode: code,
        now,
      });
      return this.create(tx, ticket, window, side, visit.id, now);
    });
  }

  /** Either side, with a code; consent goes with it. */
  cancel(
    ticketId: string,
    visitId: string,
    reasonCode: string | undefined,
    audience: Audience,
  ): Promise<void> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.visitChange);
    const side = sideOf(audience);
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, audience);
      const visit = await this.access.visit(tx, ticket, visitId, audience);
      assertVisit(visit, 'cancel');
      const now = await dbNow(tx);
      await this.end(tx, ticket, visit, {
        status: 'cancelled',
        kind: 'cancelled',
        side,
        actorId: this.ctx.accountId,
        reasonCode: code,
        now,
      });
      await this.tell(
        tx,
        ticket,
        visit,
        'ticket.visit_cancelled',
        side === 'resident'
          ? [visit.technicianId]
          : [
              ...(await this.residents(tx, ticket)),
              ...(audience === 'dispatch' ? [visit.technicianId] : []),
            ],
      );
    });
  }

  // --- the technician at the door ---------------------------------------------

  /**
   * The technician is there, within [start − 30 min, end + 2 h]. The
   * residents are told; an `assigned` or `en_route` ticket starts (the 5.1
   * transition).
   * Returns the visit as the technician sees it, consent read after the
   * lock: what they may do is what was true when they arrived.
   */
  arrive(ticketId: string, visitId: string): Promise<VisitRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, 'technician');
      const visit = await this.access.visit(tx, ticket, visitId, 'technician');
      assertVisit(visit, 'arrive');
      const now = await dbNow(tx);
      if (!inArrivalWindow(visit, now))
        throw appError.conflict(
          ErrorCode.VISIT_OUTSIDE_ARRIVAL_WINDOW,
          'Not within the visit’s window',
        );
      const arrived = await tx.ticketVisit.update({
        where: { id: visit.id },
        data: { status: 'arrived', arrivedAt: now },
      });
      await this.log.write(tx, visit, {
        kind: 'arrived',
        side: 'technician',
        actorId: me,
        at: now,
      });
      if (can(ticket.status, 'start'))
        await this.work.moveInTx(tx, ticket, 'in_progress');
      await this.tell(
        tx,
        ticket,
        arrived,
        'ticket.visit_arrived',
        await this.residents(tx, ticket),
      );
      return this.read(tx, ticket, arrived);
    });
  }

  /**
   * The residents' side says the technician is really at the door (ADR
   * 0038): once, while the visit is `arrived`. The technician is told.
   * Nothing else moves: the arrival already started the ticket.
   */
  confirmArrival(ticketId: string, visitId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, 'resident');
      const visit = await this.access.visit(tx, ticket, visitId, 'resident');
      assertVisit(visit, 'confirmArrival');
      if (visit.arrivalConfirmedAt)
        throw appError.conflict(
          ErrorCode.VISIT_ARRIVAL_ALREADY_CONFIRMED,
          'The arrival is already confirmed',
        );
      const now = await dbNow(tx);
      await tx.ticketVisit.update({
        where: { id: visit.id },
        data: { arrivalConfirmedAt: now, arrivalConfirmedById: me },
      });
      await this.log.write(tx, visit, {
        kind: 'arrival_confirmed',
        side: 'resident',
        actorId: me,
        at: now,
      });
      await this.tell(tx, ticket, visit, 'ticket.visit_arrival_confirmed', [
        visit.technicianId,
      ]);
    });
  }

  /** The visit is over; the ticket goes on by its own rules. */
  done(ticketId: string, visitId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, 'technician');
      const visit = await this.access.visit(tx, ticket, visitId, 'technician');
      assertVisit(visit, 'done');
      const now = await dbNow(tx);
      await tx.ticketVisit.update({
        where: { id: visit.id },
        data: { status: 'done', finishedAt: now },
      });
      await this.log.write(tx, visit, {
        kind: 'done',
        side: 'technician',
        actorId: me,
        at: now,
      });
    });
  }

  /**
   * Nobody let the technician in: the ticket waits for the resident (the
   * 5.1 hold, `awaiting_resident`), and the residents are asked to choose a
   * new time.
   */
  noAccess(ticketId: string, visitId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, 'technician');
      const visit = await this.access.visit(tx, ticket, visitId, 'technician');
      assertVisit(visit, 'noAccess');
      const now = await dbNow(tx);
      await tx.ticketVisit.update({
        where: { id: visit.id },
        data: { status: 'no_access', finishedAt: now },
      });
      await this.log.write(tx, visit, {
        kind: 'no_access',
        side: 'technician',
        actorId: me,
        at: now,
      });
      if (can(ticket.status, 'hold'))
        await this.work.moveInTx(tx, ticket, 'on_hold', 'awaiting_resident');
      await this.tell(
        tx,
        ticket,
        visit,
        'ticket.visit_no_access',
        await this.residents(tx, ticket),
      );
    });
  }

  // --- reads ---------------------------------------------------------------------

  /**
   * Free windows for a visit (ADR 0038): the compound's visiting hours cut
   * into slots, in its time zone, from `from` (today by default) for `days`
   * days, minus what a proposal would be refused for (too soon, too far)
   * and the technician's other active visits. For the residents who reach
   * the ticket's visits; the ticket must be in a technician's hands. It
   * says nothing about why a slot is missing, so nobody learns another
   * home's window from it. A read: `counter` and `reschedule` still check
   * the window they get, under the ticket's lock.
   */
  slots(
    ticketId: string,
    q: { from?: LocalDate; days?: number },
  ): Promise<Slot[]> {
    // The DTO checked the shape; this is a real day (not 2030-02-31).
    if (q.from !== undefined && addDays(q.from, 0) !== q.from)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid day', {
        fields: [
          {
            field: 'from',
            code: FieldErrorCode.INVALID_FORMAT,
            params: { format: 'YYYY-MM-DD' },
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forRead(tx, ticketId, 'resident');
      if (ticket.unitId === null)
        throw appError.conflict(
          ErrorCode.VISIT_NOT_FOR_COMMON_AREA,
          'A common-area ticket has no visits',
        );
      assertCan(ticket, 'visit');
      const settings = await this.maintenanceSettings.inTx(tx);
      const { timezone } = await this.tenantSettings.inTx(tx, ticket.tenantId);
      const now = await dbNow(tx);
      const from = q.from ?? localDate(now, timezone);
      const days = q.days ?? DEFAULT_SLOT_DAYS;
      // A day either side covers every time zone's offset.
      const lo = new Date(`${addDays(from, -1)}T00:00:00.000Z`);
      const hi = new Date(`${addDays(from, days + 1)}T00:00:00.000Z`);
      const busy = await tx.ticketVisit.findMany({
        where: {
          technicianId: ticket.technicianId!,
          status: { in: [...ACTIVE] },
          // The ticket's own visit is the one being moved.
          ticketId: { not: ticket.id },
          startsAt: { lt: hi },
          endsAt: { gt: lo },
        },
        select: { startsAt: true, endsAt: true },
      });
      return freeSlots({
        from,
        days,
        hours: {
          startMinute: settings.visitHoursStart,
          endMinute: settings.visitHoursEnd,
          slotMinutes: settings.visitSlotMinutes,
        },
        timeZone: timezone,
        now,
        busy,
      });
    });
  }

  /** A ticket's visits, newest first: the technician sees their own. */
  list(ticketId: string, audience: Audience): Promise<VisitRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forRead(tx, ticketId, audience);
      const visits = await tx.ticketVisit.findMany({
        where: {
          ticketId: ticket.id,
          ...(audience === 'technician'
            ? { technicianId: this.ctx.accountId }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const out: VisitRead[] = [];
      for (const v of visits) out.push(await this.read(tx, ticket, v));
      return out;
    });
  }

  /**
   * The active and upcoming visits of a unit, for an adult who lives there
   * (`visitConsent`): what is coming and who lets the technician in,
   * without the tickets themselves.
   */
  forUnit(unitId: string): Promise<UnitVisitRead[]> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const place = await this.community.placeIn(tx, me, unitId);
      if (!place)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (!(await this.community.mayConsent(tx, me, unitId)))
        throw appError.forbidden(
          ErrorCode.VISITS_NOT_ALLOWED,
          'Only an adult who lives here sees its visits',
        );
      const visits = await tx.ticketVisit.findMany({
        where: { status: { in: [...ACTIVE] }, ticket: { unitId } },
        include: {
          ticket: {
            select: {
              id: true,
              number: true,
              status: true,
              unitId: true,
              category: {
                select: { id: true, key: true, nameAr: true, nameEn: true },
              },
            },
          },
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      });
      const out: UnitVisitRead[] = [];
      for (const v of visits) {
        const { ticket, ...visit } = v;
        out.push({
          ...(await this.read(tx, ticket, visit)),
          ticket,
          category: ticket.category,
        });
      }
      return out;
    });
  }

  /** Dispatch: every visit event of the ticket, oldest first. */
  events(
    ticketId: string,
  ): Promise<{ rows: TicketVisitEvent[]; people: Map<string, Person> }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.forRead(tx, ticketId, 'dispatch');
      const rows = await tx.ticketVisitEvent.findMany({
        where: { ticketId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      });
      const people = new Map<string, Person>();
      await this.tickets.addPeople(
        tx,
        people,
        rows.map((r) => r.actorId),
      );
      return { rows, people };
    });
  }

  // --- shared with consent, the receiver and the lifecycle --------------------

  /**
   * Ends an active visit (cancelled or rescheduled): its consent is void
   * and its receiver cleared, never carried over. Under the ticket's lock.
   */
  async end(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id'>,
    visit: TicketVisit,
    how: {
      status: 'cancelled' | 'rescheduled';
      kind: Extract<VisitEventKind, 'cancelled' | 'rescheduled' | 'countered'>;
      side: VisitSide;
      actorId: string | null;
      reasonCode: string | null;
      now: Date;
    },
  ): Promise<void> {
    const actorId = how.side === 'system' ? null : how.actorId;
    await tx.ticketVisit.update({
      where: { id: visit.id },
      data: {
        status: how.status,
        cancelledAt: how.now,
        cancelReasonCode: how.reasonCode,
        cancelledBySide: how.side,
        cancelledById: actorId,
        absenceEntryApproved: false,
        consentById: null,
        consentAt: null,
        receiverKind: null,
        receiverAccountId: null,
        receiverEngagementId: null,
      },
    });
    await this.log.write(tx, visit, {
      kind: how.kind,
      side: how.side,
      actorId,
      reasonCode: how.reasonCode,
      at: how.now,
    });
    if (visit.absenceEntryApproved)
      await this.log.write(tx, visit, {
        kind: 'consent_voided',
        side: 'system',
        actorId: null,
        reasonCode: how.side === 'system' ? how.reasonCode : null,
        at: how.now,
      });
  }

  /** The ticket's active visit, if any (under the caller's ticket lock). */
  active(tx: TenantTxClient, ticketId: string): Promise<TicketVisit | null> {
    return tx.ticketVisit.findFirst({
      where: { ticketId, status: { in: [...ACTIVE] } },
    });
  }

  /**
   * Everyone on the residents' side: those who live there, and the reporter
   * while they still have `tickets` on the unit. A notice carries the
   * window, so a reporter who left is never told (ADR 0034); checked here,
   * in the transaction that writes it.
   */
  async residents(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'unitId' | 'reporterId'>,
  ): Promise<string[]> {
    if (!ticket.unitId) return [ticket.reporterId];
    const out = await this.community.consenters(tx, ticket.unitId);
    if (
      (await this.community.placeIn(tx, ticket.reporterId, ticket.unitId))
        ?.tickets
    )
      out.push(ticket.reporterId);
    return out;
  }

  /** A visit notice: the ticket number and the window, nothing else. */
  async tell(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'number'>,
    visit: Pick<TicketVisit, 'startsAt' | 'endsAt'>,
    kind: NotificationKind,
    to: readonly (string | null)[],
  ): Promise<void> {
    await this.notices.sendBare(
      tx,
      to,
      kind,
      ticket,
      {
        startsAt: visit.startsAt.toISOString(),
        endsAt: visit.endsAt.toISOString(),
      },
      this.ctx.accountIdOrNull(),
    );
  }

  /** A visit with its people and its receiver, if still valid. */
  async read(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'unitId'>,
    visit: TicketVisit,
  ): Promise<VisitRead> {
    const people = new Map<string, Person>();
    await this.tickets.addPeople(tx, people, [
      visit.technicianId,
      visit.proposedById,
      visit.confirmedById,
      visit.consentById,
      visit.cancelledById,
      visit.arrivalConfirmedById,
    ]);
    return { visit, receiver: await this.receiver(tx, ticket, visit), people };
  }

  /**
   * The receiver, if they may still receive the technician: a household
   * account that may consent there, or an active worker of the unit (read
   * live). Anyone else reads as no receiver.
   */
  private async receiver(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'unitId'>,
    visit: TicketVisit,
  ): Promise<ReceiverRead | null> {
    if (!ticket.unitId) return null;
    if (visit.receiverKind === 'household' && visit.receiverAccountId) {
      if (
        !(await this.community.mayConsent(
          tx,
          visit.receiverAccountId,
          ticket.unitId,
        ))
      )
        return null;
      const account = await tx.account.findUnique({
        where: { id: visit.receiverAccountId },
        select: { fullName: true },
      });
      return {
        kind: 'household',
        id: visit.receiverAccountId,
        fullName: account?.fullName ?? null,
      };
    }
    if (visit.receiverKind === 'worker' && visit.receiverEngagementId) {
      const worker = await this.community.activeWorker(
        tx,
        ticket.unitId,
        visit.receiverEngagementId,
      );
      return worker
        ? {
            kind: 'worker',
            id: worker.engagementId,
            fullName: worker.fullName,
          }
        : null;
    }
    return null;
  }

  /** A new proposal; a technician-side one is a response (ADR 0034). */
  private async create(
    tx: TenantTxClient,
    ticket: Ticket,
    window: Window,
    side: 'technician' | 'resident',
    previousVisitId: string | null,
    now: Date,
  ): Promise<TicketVisit> {
    const me = this.ctx.accountId;
    const visit = await tx.ticketVisit.create({
      data: {
        id: newId(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        cycle: ticket.cycle,
        technicianId: ticket.technicianId!,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        proposedBySide: side,
        proposedById: me,
        previousVisitId,
      },
    });
    await this.log.write(tx, visit, {
      kind: 'proposed',
      side,
      actorId: me,
      at: now,
    });
    if (side === 'technician') await this.sla.responded(tx, ticket);
    await this.tell(
      tx,
      ticket,
      visit,
      'ticket.visit_proposed',
      side === 'technician'
        ? [
            ...(await this.residents(tx, ticket)),
            // A dispatcher proposing for the technician tells them too.
            ticket.technicianId,
          ]
        : [visit.technicianId],
    );
    return visit;
  }
}
