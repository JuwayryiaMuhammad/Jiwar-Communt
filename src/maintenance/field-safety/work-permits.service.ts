import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Ticket, WorkPermit } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';
import { TicketAccess } from '../tickets/ticket-access';
import { WorkService } from '../tickets/work.service';
import {
  hazardsOf,
  MAX_PERMIT_HOURS,
  OPEN_PERMIT,
  PERMIT_TICKET_STATUSES,
  type Hazard,
  type WorkPermitStatus,
} from './safety-rules';
import { WorkPermitView } from './views/field-safety.views';

export const WORK_PERMIT_RESOURCE = 'work_permit';
const HOUR = 3_600_000;

export interface PermitRequest {
  hazard: Hazard;
  precautions: string;
  expiresAt: Date;
}

export interface PermitsQuery {
  status?: WorkPermitStatus;
  ticketId?: string;
  cursor?: string;
  limit?: number;
}

export interface TicketPermits {
  ticketId: string;
  cycle: number;
  /** What its work needs a permit for: its category's and its asset type's. */
  hazards: Hazard[];
  permits: WorkPermit[];
}

const PAGE = keysetCursor('requestedAt');

export const permitNotFound = () =>
  appError.notFound(ErrorCode.WORK_PERMIT_NOT_FOUND, 'Work permit not found');
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid work permit', {
    fields,
  });

/**
 * Work permits (ADR 0067): the technician asks for one for a hazard on
 * their own ticket's cycle, with the precautions they will take and when
 * it expires (within a day); `safety.manage` approves or rejects it once,
 * and may revoke an approved one. The work starts, or resumes, only with an
 * approved permit in force for every hazard it needs (assertSafeToStart,
 * under the ticket's lock). Completing the work closes the cycle's open
 * permits. One open permit per ticket, cycle and hazard. The precautions
 * are the technician's words: audited as changed only, never in a notice.
 *
 * Locks: the caller's account (shared), the ticket (FOR UPDATE), then the
 * permit (FOR UPDATE) — so a decision, a revocation and a start on one
 * ticket go one at a time.
 */
@Injectable()
export class WorkPermitsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly work: WorkService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(WORK_PERMIT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        WorkPermitView.from(await this.find(tx, id)),
      ),
    );
    this.work.onCompleting((tx, ticket) => this.closeOpen(tx, ticket));
  }

  // ---------------------------------------------------------------- reads

  /** Every permit, the latest asked first, for who decides them. */
  list(q: PermitsQuery): Promise<Page<WorkPermit>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.workPermit.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.ticketId ? { ticketId: q.ticketId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<WorkPermit> {
    return this.tenantTx.withTenantTx((tx) => this.find(tx, id));
  }

  /** A ticket's hazards and its current cycle's permits: the dispatch's, or the technician's own ticket. */
  ofTicket(
    ticketId: string,
    as: 'dispatch' | 'technician',
  ): Promise<TicketPermits> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, ticketId, as);
      return {
        ticketId,
        cycle: ticket.cycle,
        hazards: await hazardsOf(tx, ticket),
        permits: await tx.workPermit.findMany({
          where: { ticketId, cycle: ticket.cycle },
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        }),
      };
    });
  }

  // ---------------------------------------------------------- the request

  /** The technician asks, on their own ticket in their hands. */
  request(ticketId: string, input: PermitRequest): Promise<WorkPermit> {
    const precautions = input.precautions.trim();
    if (!precautions)
      throw invalid([
        {
          field: 'precautions',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: 2000 },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: WORK_PERMIT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'technician', {
        lock: true,
      });
      if (
        !(PERMIT_TICKET_STATUSES as readonly string[]).includes(ticket.status)
      )
        throw appError.conflict(
          ErrorCode.WORK_PERMIT_TICKET_STATUS,
          'This ticket takes no permit now',
          { params: { status: ticket.status } },
        );
      const now = await dbNow(tx);
      const left = input.expiresAt.getTime() - now.getTime();
      if (left <= 0 || left > MAX_PERMIT_HOURS * HOUR)
        throw invalid([
          {
            field: 'expiresAt',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxHours: MAX_PERMIT_HOURS },
          },
        ]);
      const open = await tx.workPermit.findFirst({
        where: {
          ticketId,
          cycle: ticket.cycle,
          hazard: input.hazard,
          status: { in: [...OPEN_PERMIT] },
        },
        select: { id: true },
      });
      if (open)
        throw appError.conflict(
          ErrorCode.WORK_PERMIT_OPEN,
          'A permit for this hazard is open on this ticket',
          { params: { permitId: open.id } },
        );
      const permit = await tx.workPermit.create({
        data: {
          id,
          tenantId: ticket.tenantId,
          ticketId,
          cycle: ticket.cycle,
          hazard: input.hazard,
          precautions,
          expiresAt: input.expiresAt,
          requestedById: this.ctx.accountId,
          requestedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'work_permit.requested',
        targetId: id,
        metadata: {
          ticketId,
          cycle: ticket.cycle,
          hazard: input.hazard,
          expiresAt: input.expiresAt.toISOString(),
        },
        changes: { precautions: { changed: true } },
      });
      await this.tell(
        tx,
        (await this.staff.holding(tx, 'safety.manage')).map((r) => r.id),
        'work_permit.requested',
        permit,
        ticket,
      );
      return permit;
    });
  }

  // ------------------------------------------------------------ decisions

  /** Approved once, before it expires. */
  approve(id: string): Promise<WorkPermit> {
    return this.decide(id, async (tx, permit, ticket, now) => {
      if (permit.expiresAt.getTime() <= now.getTime())
        throw appError.conflict(
          ErrorCode.WORK_PERMIT_EXPIRED,
          'This permit’s time is past',
        );
      const approved = await tx.workPermit.update({
        where: { id },
        data: {
          status: 'approved',
          decidedById: this.ctx.accountId,
          decidedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'work_permit.approved',
        targetId: id,
        metadata: { ticketId: permit.ticketId, hazard: permit.hazard },
      });
      await this.tell(
        tx,
        [permit.requestedById],
        'work_permit.approved',
        approved,
        ticket,
      );
      return approved;
    });
  }

  /** Rejected once, with a reason code. */
  reject(id: string, reasonCode: string | undefined): Promise<WorkPermit> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.workPermitReject,
    );
    return this.decide(id, async (tx, permit, ticket, now) => {
      const rejected = await tx.workPermit.update({
        where: { id },
        data: {
          status: 'rejected',
          decidedById: this.ctx.accountId,
          decidedAt: now,
          rejectReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'work_permit.rejected',
        targetId: id,
        metadata: {
          ticketId: permit.ticketId,
          hazard: permit.hazard,
          reasonCode: reason,
        },
      });
      await this.tell(
        tx,
        [permit.requestedById],
        'work_permit.rejected',
        rejected,
        ticket,
      );
      return rejected;
    });
  }

  /**
   * An approved permit revoked once, with a reason code; the technician is
   * told. Work under way stays where it is, but does not resume after a
   * hold without a new permit.
   */
  revoke(id: string, reasonCode: string | undefined): Promise<WorkPermit> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.workPermitRevoke,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const { permit, ticket } = await this.lock(tx, id);
      if (permit.status !== 'approved')
        throw appError.conflict(
          ErrorCode.WORK_PERMIT_DECIDED,
          'Only an approved permit is revoked',
          { params: { status: permit.status } },
        );
      const now = await dbNow(tx);
      const revoked = await tx.workPermit.update({
        where: { id },
        data: {
          status: 'revoked',
          revokedById: this.ctx.accountId,
          revokedAt: now,
          revokeReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'work_permit.revoked',
        targetId: id,
        metadata: {
          ticketId: permit.ticketId,
          hazard: permit.hazard,
          reasonCode: reason,
          ticketStatus: ticket.status,
        },
      });
      await this.tell(
        tx,
        [permit.requestedById],
        'work_permit.revoked',
        revoked,
        ticket,
      );
      return revoked;
    });
  }

  /** The completion hook: the cycle's open permits are closed with the work. */
  private async closeOpen(tx: TenantTxClient, ticket: Ticket): Promise<void> {
    const open = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM work_permits
       WHERE ticket_id = ${ticket.id}::uuid AND cycle = ${ticket.cycle}
         AND status IN ('requested', 'approved')
       ORDER BY id FOR UPDATE`;
    if (!open.length) return;
    const now = await dbNow(tx);
    await tx.workPermit.updateMany({
      where: { id: { in: open.map((p) => p.id) } },
      data: { status: 'closed', closedAt: now },
    });
  }

  // ------------------------------------------------------------ internals

  private decide(
    id: string,
    apply: (
      tx: TenantTxClient,
      permit: WorkPermit,
      ticket: Ticket,
      now: Date,
    ) => Promise<WorkPermit>,
  ): Promise<WorkPermit> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { permit, ticket } = await this.lock(tx, id);
      if (permit.status !== 'requested' || permit.cycle !== ticket.cycle)
        throw appError.conflict(
          ErrorCode.WORK_PERMIT_DECIDED,
          'This permit was decided, or its work is over',
          { params: { status: permit.status } },
        );
      return apply(tx, permit, ticket, await dbNow(tx));
    });
  }

  /** The caller, the permit's ticket (FOR UPDATE), then the permit. */
  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<{ permit: WorkPermit; ticket: Ticket }> {
    await this.access.lockSelf(tx);
    const seen = await this.find(tx, id);
    const ticket = await this.access.load(tx, seen.ticketId, 'dispatch', {
      lock: true,
    });
    await tx.$queryRaw`SELECT id FROM work_permits WHERE id = ${id}::uuid FOR UPDATE`;
    return { permit: await this.find(tx, id), ticket };
  }

  private async find(tx: TenantTxClient, id: string): Promise<WorkPermit> {
    const permit = await tx.workPermit.findUnique({ where: { id } });
    if (!permit) throw permitNotFound();
    return permit;
  }

  /** The hazard and the ticket's number: never the precautions. */
  private async tell(
    tx: TenantTxClient,
    to: string[],
    kind:
      | 'work_permit.requested'
      | 'work_permit.approved'
      | 'work_permit.rejected'
      | 'work_permit.revoked',
    permit: WorkPermit,
    ticket: Ticket,
  ): Promise<void> {
    const active = await tx.account.findMany({
      where: {
        id: { in: to.filter((id) => id !== this.ctx.accountId) },
        status: 'active',
      },
      select: { id: true },
    });
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      {
        kind,
        params: { hazard: permit.hazard, ticketNumber: String(ticket.number) },
        targetId: ticket.id,
      },
    );
  }
}
