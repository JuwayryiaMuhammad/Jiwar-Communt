import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TechnicianHelpKind, TechnicianHelpRequest } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { ticketNumber } from '../tickets/ticket-rules';
import { HelpRequestView, type HelpNames } from './views/help-request.views';

export const HELP_ESCALATION_SWEEP = 'maintenance.help_escalation';
/** A call nobody took this long is escalated to the managers, once. */
export const HELP_ESCALATE_AFTER_MINUTES = 15;
const MINUTE = 60_000;
const MAX_LIST = 200;
const SWEEP_BATCH = 200;
const NOTE_MAX = 500;

const notFound = () =>
  appError.notFound(
    ErrorCode.TECHNICIAN_HELP_NOT_FOUND,
    'Call for help not found',
  );
const closed = (status: string) =>
  appError.conflict(
    ErrorCode.TECHNICIAN_HELP_CLOSED,
    'The call was taken, resolved or called off already',
    { params: { status } },
  );

/**
 * A technician's call for help (ADR 0078): more hands, someone who knows
 * the fault, parts, or a second person for safety, about one of their own
 * tickets or none.
 *
 * - **One live call per technician**, decided under their help lock
 *   (a partial unique index behind it): TECHNICIAN_HELP_LIVE.
 * - **The field team** (`field_team.manage`) is told at once (critical)
 *   and takes it, naming another technician to send or none; the helper is
 *   told (critical), the caller too. Taken once: the row is taken FOR
 *   UPDATE, the first wins.
 * - **Resolved** by the caller, the helper or the field team once taken;
 *   **called off** by the caller while open or taken.
 * - **Escalated** to the managers, once, when nobody took it in fifteen
 *   minutes: a sweep every minute, SKIP LOCKED and judged again under the
 *   row's lock, so a taking holding it wins.
 * - The note is the caller's own words: the field team and the helper read
 *   it; notifications carry only the closed kind.
 */
@Injectable()
export class HelpRequestsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly sweep: SweepRunner,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.sweep.register(HELP_ESCALATION_SWEEP, (now) => this.escalate(now), {
      intervalMs: MINUTE,
    });
    // A technician who leaves calls off their live call; an erased one's
    // notes go too (ADR 0036).
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.left(tx, account.id);
      return [];
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.left(tx, account.id);
      await this.forget(tx, account.id);
      return [];
    });
  }

  /** A technician calls for help. */
  request(input: {
    kind: TechnicianHelpKind;
    ticketId?: string;
    note?: string;
  }): Promise<HelpRequestView> {
    const note = input.note?.trim() || null;
    if (note && note.length > NOTE_MAX)
      throw invalid([
        {
          field: 'note',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: NOTE_MAX },
        },
      ]);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`technician-help:${this.ctx.txTenantId}:${me}`}))`;
      if (input.ticketId) {
        // Their own ticket: one assigned to them, read FOR SHARE.
        const [ticket] = await tx.$queryRaw<{ technician: string | null }[]>`
          SELECT technician_account_id AS technician FROM tickets
           WHERE id = ${input.ticketId}::uuid FOR SHARE`;
        if (ticket?.technician !== me)
          throw appError.notFound(
            ErrorCode.TICKET_NOT_FOUND,
            'Ticket not found',
          );
      }
      const live = await tx.technicianHelpRequest.count({
        where: { requesterId: me, status: { in: ['open', 'taken'] } },
      });
      if (live)
        throw appError.conflict(
          ErrorCode.TECHNICIAN_HELP_LIVE,
          'You have a live call for help already',
        );
      const id = newId();
      const row = await tx.technicianHelpRequest.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          requesterId: me,
          kind: input.kind,
          ticketId: input.ticketId ?? null,
          note,
          createdAt: await dbNow(tx),
        },
      });
      await this.tell(
        tx,
        await this.fieldTeam(tx, [me]),
        'technician_help.requested',
        row,
      );
      await this.audit.record(tx, {
        action: 'technician_help.requested',
        targetId: id,
        metadata: {
          kind: input.kind,
          ...(input.ticketId ? { ticketId: input.ticketId } : {}),
        },
      });
      return this.view(tx, row);
    });
  }

  /** The caller's calls, and those they were sent to help, newest first. */
  mine(): Promise<HelpRequestView[]> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.technicianHelpRequest.findMany({
        where: { OR: [{ requesterId: me }, { helperId: me }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_LIST,
      });
      return this.views(tx, rows);
    });
  }

  /** The field team's list, newest first. */
  list(q: {
    status?: 'open' | 'taken' | 'resolved' | 'cancelled';
  }): Promise<HelpRequestView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.technicianHelpRequest.findMany({
        where: q.status ? { status: q.status } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_LIST,
      });
      return this.views(tx, rows);
    });
  }

  /** One call, as the field team reads it. */
  get(id: string): Promise<HelpRequestView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.technicianHelpRequest.findUnique({ where: { id } });
      if (!row) throw notFound();
      return this.view(tx, row);
    });
  }

  /**
   * The field team takes an open call, sending another technician or none:
   * an active `tickets.work` holder, never the caller (GUARD_NOT_ELIGIBLE).
   */
  take(id: string, helperId?: string): Promise<HelpRequestView> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw notFound();
      if (row.status !== 'open') throw closed(row.status);
      if (row.requesterId === me)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Your own call is the field team’s to take',
        );
      if (helperId) {
        const helper = await tx.account.count({
          where: {
            id: helperId,
            status: 'active',
            role: { permissions: { some: { permission: 'tickets.work' } } },
          },
        });
        if (!helper || helperId === row.requesterId)
          throw invalid([
            { field: 'helperId', code: FieldErrorCode.GUARD_NOT_ELIGIBLE },
          ]);
      }
      const taken = await tx.technicianHelpRequest.update({
        where: { id },
        data: {
          status: 'taken',
          takenById: me,
          takenAt: await dbNow(tx),
          helperId: helperId ?? null,
        },
      });
      await this.tell(tx, [row.requesterId], 'technician_help.taken', taken);
      if (helperId)
        await this.tell(tx, [helperId], 'technician_help.assigned', taken);
      await this.audit.record(tx, {
        action: 'technician_help.taken',
        targetId: id,
        metadata: helperId ? { helperId } : {},
      });
      return this.view(tx, taken);
    });
  }

  /**
   * Resolved once taken: by the caller or the helper (`as: 'technician'`),
   * or by the field team. Before it was taken, the caller calls it off.
   */
  resolve(
    id: string,
    as: 'technician' | 'field_team',
  ): Promise<HelpRequestView> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row || (as === 'technician' && !this.involves(row, me)))
        throw notFound();
      if (row.status !== 'taken') throw closed(row.status);
      const resolved = await tx.technicianHelpRequest.update({
        where: { id },
        data: {
          status: 'resolved',
          resolvedAt: await dbNow(tx),
          resolvedById: me,
        },
      });
      await this.audit.record(tx, {
        action: 'technician_help.resolved',
        targetId: id,
        metadata: {
          by:
            me === row.requesterId
              ? 'requester'
              : me === row.helperId
                ? 'helper'
                : 'field_team',
        },
      });
      return this.view(tx, resolved);
    });
  }

  /** The caller calls it off while open or taken. */
  cancel(id: string): Promise<HelpRequestView> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row || row.requesterId !== me) throw notFound();
      if (row.status !== 'open' && row.status !== 'taken')
        throw closed(row.status);
      const cancelled = await tx.technicianHelpRequest.update({
        where: { id },
        data: { status: 'cancelled', cancelledAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'technician_help.cancelled',
        targetId: id,
        metadata: { was: row.status },
      });
      return this.view(tx, cancelled);
    });
  }

  /**
   * Calls nobody took in fifteen minutes, one transaction each: taken with
   * SKIP LOCKED and judged again under the lock, so a taking or a call-off
   * holding it wins. Marked once (`escalated_at`, which the trigger sets
   * once while open); the managers are told.
   */
  escalate(now: Date): Promise<number> {
    const due = new Date(now.getTime() - HELP_ESCALATE_AFTER_MINUTES * MINUTE);
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.technicianHelpRequest.findMany({
            where: {
              status: 'open',
              escalatedAt: null,
              createdAt: { lte: due },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: SWEEP_BATCH,
            select: { id: true },
          })
        ).map((r) => r.id),
      async (tx, _tenantId, id) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM technician_help_requests
           WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const row = await tx.technicianHelpRequest.findUniqueOrThrow({
          where: { id },
        });
        if (row.status !== 'open' || row.escalatedAt || row.createdAt > due)
          return 0;
        // By the database's clock: never after a taking that follows.
        const escalated = await tx.technicianHelpRequest.update({
          where: { id },
          data: { escalatedAt: await dbNow(tx) },
        });
        const managers = (
          await tx.account.findMany({
            where: { type: 'manager', status: 'active' },
            select: { id: true },
            orderBy: { id: 'asc' },
          })
        ).map((a) => a.id);
        await this.tell(tx, managers, 'technician_help.escalated', escalated);
        await this.audit.record(tx, {
          action: 'technician_help.escalated',
          targetId: id,
          metadata: { recipients: managers.length },
        });
        return 1;
      },
    );
  }

  /** Their live call, called off by the system, under its row. */
  private async left(tx: TenantTxClient, accountId: string): Promise<void> {
    const live = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text AS status FROM technician_help_requests
       WHERE requester_account_id = ${accountId}::uuid
         AND status IN ('open', 'taken')
       ORDER BY id FOR UPDATE`;
    const now = await dbNow(tx);
    for (const r of live) {
      await tx.technicianHelpRequest.update({
        where: { id: r.id },
        data: { status: 'cancelled', cancelledAt: now },
      });
      await this.audit.record(tx, {
        action: 'technician_help.cancelled',
        targetId: r.id,
        metadata: { was: r.status, by: 'system' },
      });
    }
  }

  /** Their notes cleared, once each. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM technician_help_requests
       WHERE requester_account_id = ${accountId}::uuid AND note IS NOT NULL
       ORDER BY id FOR UPDATE`;
    for (const { id } of rows) {
      await tx.technicianHelpRequest.update({
        where: { id },
        data: { note: null },
      });
      await this.audit.record(tx, {
        action: 'technician_help.note_cleared',
        targetId: id,
      });
    }
  }

  // --------------------------------------------------------------------------

  private involves(row: TechnicianHelpRequest, accountId: string): boolean {
    return row.requesterId === accountId || row.helperId === accountId;
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<TechnicianHelpRequest | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM technician_help_requests WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) return null;
    return tx.technicianHelpRequest.findUniqueOrThrow({ where: { id } });
  }

  /** The field team: active `field_team.manage` holders, but `except`. */
  private async fieldTeam(
    tx: TenantTxClient,
    except: readonly string[],
  ): Promise<string[]> {
    return (
      await tx.account.findMany({
        where: {
          status: 'active',
          id: { notIn: [...except] },
          role: {
            permissions: { some: { permission: 'field_team.manage' } },
          },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((a) => a.id);
  }

  private async tell(
    tx: TenantTxClient,
    to: readonly string[],
    kind:
      | 'technician_help.requested'
      | 'technician_help.taken'
      | 'technician_help.assigned'
      | 'technician_help.escalated',
    row: TechnicianHelpRequest,
  ): Promise<void> {
    if (!to.length) return;
    await this.notifier.notify(tx, [...to], {
      kind,
      params: kind === 'technician_help.taken' ? {} : { helpKind: row.kind },
      targetId: row.id,
    });
  }

  private async view(
    tx: TenantTxClient,
    row: TechnicianHelpRequest,
  ): Promise<HelpRequestView> {
    return (await this.views(tx, [row]))[0];
  }

  private async views(
    tx: TenantTxClient,
    rows: readonly TechnicianHelpRequest[],
  ): Promise<HelpRequestView[]> {
    const ids = [
      ...new Set(
        rows.flatMap((r) =>
          [r.requesterId, r.takenById, r.helperId].filter(
            (x): x is string => x !== null,
          ),
        ),
      ),
    ];
    const ticketIds = [
      ...new Set(rows.flatMap((r) => (r.ticketId ? [r.ticketId] : []))),
    ];
    const names: HelpNames = {
      people: new Map(
        (ids.length
          ? await tx.account.findMany({
              where: { id: { in: ids } },
              select: { id: true, fullName: true, status: true },
            })
          : []
        ).map((a) => [a.id, a]),
      ),
      tickets: new Map(
        (ticketIds.length
          ? await tx.ticket.findMany({
              where: { id: { in: ticketIds } },
              select: { id: true, number: true },
            })
          : []
        ).map((t) => [t.id, ticketNumber(t.number)]),
      ),
    };
    return rows.map((r) => HelpRequestView.from(r, names));
  }
}
