import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  ReinforcementCall,
  ReinforcementCallRecipient,
  ReinforcementSuggestion,
} from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { StaffDuty } from '../../core/staff-duty/staff-duty';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';

export const REINFORCEMENT_SWEEP = 'maintenance.reinforcement';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A call starts this soon at the earliest, and within 12 hours. */
export const CALL_LEAD_MINUTES = 15;
export const CALL_AHEAD_HOURS = 12;
/** A window of 1 to 12 hours. */
export const CALL_HOURS = { min: 1, max: 12 } as const;
export const CALL_NEEDED = { min: 1, max: 10 } as const;
const LIST_MAX = 200;

type Person = { id: string; fullName: string | null; status: string };

export interface CallRead {
  call: ReinforcementCall;
  sentBy: Person;
  zone: { id: string; nameEn: string; nameAr: string } | null;
  /** The field team's read: whom it reached and their answers. */
  recipients: (ReinforcementCallRecipient & { person: Person })[] | null;
  /** The technician's read: their own answer. */
  mine: ReinforcementCallRecipient | null;
}

export interface SuggestionRead {
  suggestion: ReinforcementSuggestion;
  decidedBy: Person | null;
}

const callNotFound = () =>
  appError.notFound(ErrorCode.REINFORCEMENT_CALL_NOT_FOUND, 'Call not found');
const suggestionNotFound = () =>
  appError.notFound(
    ErrorCode.REINFORCEMENT_SUGGESTION_NOT_FOUND,
    'Suggestion not found',
  );
const callClosed = (status: string) =>
  appError.conflict(
    ErrorCode.REINFORCEMENT_CALL_CLOSED,
    'This call is filled, closed or called off',
    { params: { status } },
  );

/**
 * Peak reinforcement (ADR 0090): the system suggests, the field team
 * decides; nothing reaches a technician off duty by itself.
 *
 * - **A suggestion** is made when service pressure's rise is told (ADR
 *   0079), one open per compound, under the pressure row's lock; it is the
 *   field team's inbox item (`reinforcement_suggestion`, due in an hour),
 *   answered by a call, dismissed with a code, or lapsed when the pressure
 *   eases.
 * - **A call** (`field_team.manage`, by hand or answering the suggestion)
 *   asks the technicians off duty — active `tickets.work` holders not
 *   available now — to come in: 1 to 10 of them, for a window that starts
 *   15 minutes to 12 hours ahead and lasts 1 to 12 hours, in a zone or the
 *   whole compound. Each is told (critical) and answers once.
 * - **Accepting** writes a single roster slot for the window (ADR 0078),
 *   through the gate's writer, under the technician's roster lock: an
 *   overlap is refused (ROSTER_OVERLAP) and nothing is recorded. Going on
 *   duty then fills it, with its lateness and overtime.
 * - **The call ends once**: filled as many accept (the field team told),
 *   closed at its start (the sweep, every minute), or called off with a
 *   code — the accepted slots nobody filled yet are cancelled, and whoever
 *   it reached and did not decline is told.
 *
 * Locks: the technician's account (FOR SHARE), then the call FOR UPDATE,
 * then the roster lock (the slot's writer); the sweep and a call-off take
 * the call alone, then each slot.
 */
@Injectable()
export class ReinforcementService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly sweep: SweepRunner,
    private readonly inbox: StaffInbox,
    private readonly duty: StaffDuty,
  ) {}

  onModuleInit(): void {
    this.sweep.register(REINFORCEMENT_SWEEP, (now) => this.closeStarted(now), {
      intervalMs: MINUTE,
    });
    this.inbox.register({
      type: 'reinforcement_suggestion',
      permission: 'field_team.manage',
      dueHours: 1,
      page: async (tx, q) => {
        const rows = await tx.reinforcementSuggestion.findMany({
          where: {
            AND: [
              { status: 'open' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, status: true, createdAt: true },
        });
        return rows.map((r) => ({
          type: 'reinforcement_suggestion' as const,
          id: r.id,
          number: null,
          kind: null,
          status: r.status,
          unitId: null,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.reinforcementSuggestion.count({
          where: {
            AND: [{ status: 'open' }, ...waitingSince('createdAt', before)],
          },
        }),
    });
  }

  // --- suggestions, from service pressure --------------------------------------

  /**
   * Service pressure's rise was told (ADR 0079), under the pressure row's
   * lock: one open suggestion, the field team told. None while one is open.
   */
  async suggest(
    tx: TenantTxClient,
    tenantId: string,
    figures: {
      raisedAt: Date;
      open: number;
      available: number;
      threshold: number;
    },
    now: Date,
  ): Promise<void> {
    const open = await tx.reinforcementSuggestion.count({
      where: { status: 'open' },
    });
    if (open) return;
    const id = newId();
    await tx.reinforcementSuggestion.create({
      data: {
        id,
        tenantId,
        raisedAt: figures.raisedAt,
        openTickets: figures.open,
        available: figures.available,
        threshold: figures.threshold,
        createdAt: now,
      },
    });
    await this.audit.record(tx, {
      action: 'reinforcement_suggestion.suggested',
      targetId: id,
      metadata: {
        open: figures.open,
        available: figures.available,
        threshold: figures.threshold,
      },
    });
    const to = (await this.staff.holding(tx, 'field_team.manage')).map(
      (r) => r.id,
    );
    if (to.length)
      await this.notifier.notify(tx, to, {
        kind: 'reinforcement.suggested',
        params: { open: figures.open, available: figures.available },
        targetId: id,
      });
  }

  /** The pressure eased (or was turned off): the open suggestion lapses. */
  async lapse(tx: TenantTxClient, now: Date): Promise<void> {
    const [open] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM reinforcement_suggestions WHERE status = 'open' FOR UPDATE`;
    if (!open) return;
    await tx.reinforcementSuggestion.update({
      where: { id: open.id },
      data: { status: 'lapsed', decidedAt: now },
    });
    await this.audit.record(tx, {
      action: 'reinforcement_suggestion.lapsed',
      targetId: open.id,
    });
  }

  suggestions(q: {
    status?: 'open' | 'answered' | 'dismissed' | 'lapsed';
  }): Promise<SuggestionRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.reinforcementSuggestion.findMany({
        where: q.status ? { status: q.status } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_MAX,
      });
      const people = await this.people(
        tx,
        rows.map((r) => r.decidedById),
      );
      return rows.map((r) => ({
        suggestion: r,
        decidedBy: r.decidedById ? (people.get(r.decidedById) ?? null) : null,
      }));
    });
  }

  /** Dismissed once, with a code. */
  dismiss(id: string, reasonCode?: string): Promise<SuggestionRead> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.reinforcementDismiss,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockOpenSuggestion(tx, id);
      const row = await tx.reinforcementSuggestion.update({
        where: { id },
        data: {
          status: 'dismissed',
          decidedAt: await dbNow(tx),
          decidedById: this.ctx.accountId,
          reasonCode: code,
        },
      });
      await this.audit.record(tx, {
        action: 'reinforcement_suggestion.dismissed',
        targetId: id,
        metadata: { reasonCode: code },
      });
      const people = await this.people(tx, [this.ctx.accountId]);
      return {
        suggestion: row,
        decidedBy: people.get(this.ctx.accountId) ?? null,
      };
    });
  }

  // --- calls -------------------------------------------------------------------

  /**
   * The field team asks the technicians off duty to come in; answering an
   * open suggestion when it names one.
   */
  send(input: {
    needed: number;
    startsAt: Date;
    endsAt: Date;
    zoneId?: string;
    suggestionId?: string;
  }): Promise<CallRead> {
    const hours = (input.endsAt.getTime() - input.startsAt.getTime()) / HOUR;
    if (hours < CALL_HOURS.min || hours > CALL_HOURS.max)
      throw invalid([
        {
          field: 'endsAt',
          code:
            hours <= 0
              ? FieldErrorCode.ENDS_BEFORE_START
              : FieldErrorCode.INVALID_VALUE,
          params: { minHours: CALL_HOURS.min, maxHours: CALL_HOURS.max },
        },
      ]);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      if (
        input.startsAt.getTime() < now.getTime() + CALL_LEAD_MINUTES * MINUTE ||
        input.startsAt.getTime() > now.getTime() + CALL_AHEAD_HOURS * HOUR
      )
        throw invalid([
          {
            field: 'startsAt',
            code: FieldErrorCode.INVALID_VALUE,
            params: {
              minMinutes: CALL_LEAD_MINUTES,
              maxHours: CALL_AHEAD_HOURS,
            },
          },
        ]);
      if (input.zoneId) {
        const [zone] = await tx.$queryRaw<{ active: boolean }[]>`
          SELECT active FROM places WHERE id = ${input.zoneId}::uuid FOR SHARE`;
        if (!zone?.active)
          throw invalid([
            { field: 'zoneId', code: FieldErrorCode.POST_NOT_AVAILABLE },
          ]);
      }
      if (input.suggestionId)
        await this.lockOpenSuggestion(tx, input.suggestionId);
      // Off duty now: active technicians who are not available.
      const offDuty = (
        await tx.account.findMany({
          where: {
            status: 'active',
            type: 'staff',
            id: { not: me },
            role: {
              permissions: { some: { permission: 'tickets.work' } },
            },
            NOT: { availability: { is: { state: 'available' } } },
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        })
      ).map((a) => a.id);
      const id = newId();
      const call = await tx.reinforcementCall.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          sentById: me,
          suggestionId: input.suggestionId ?? null,
          needed: input.needed,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          placeId: input.zoneId ?? null,
          recipients: offDuty.length,
          sentAt: now,
        },
      });
      if (offDuty.length)
        await tx.reinforcementCallRecipient.createMany({
          data: offDuty.map((accountId) => ({
            tenantId: this.ctx.txTenantId,
            callId: id,
            accountId,
          })),
        });
      if (input.suggestionId)
        await tx.reinforcementSuggestion.update({
          where: { id: input.suggestionId },
          data: {
            status: 'answered',
            decidedAt: now,
            decidedById: me,
            callId: id,
          },
        });
      await this.audit.record(tx, {
        action: 'reinforcement_call.sent',
        targetId: id,
        metadata: {
          needed: input.needed,
          recipients: offDuty.length,
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
          ...(input.zoneId ? { zoneId: input.zoneId } : {}),
          ...(input.suggestionId ? { suggestionId: input.suggestionId } : {}),
        },
      });
      if (offDuty.length)
        await this.notifier.notify(tx, offDuty, {
          kind: 'reinforcement.called',
          params: {
            needed: input.needed,
            startsAt: input.startsAt.toISOString(),
            endsAt: input.endsAt.toISOString(),
          },
          targetId: id,
        });
      return this.read(tx, call, 'field_team');
    });
  }

  /** The field team's list, newest first. */
  calls(q: {
    status?: 'open' | 'filled' | 'closed' | 'cancelled';
  }): Promise<CallRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.reinforcementCall.findMany({
        where: q.status ? { status: q.status } : {},
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        take: LIST_MAX,
      });
      const out: CallRead[] = [];
      for (const r of rows) out.push(await this.read(tx, r, 'list'));
      return out;
    });
  }

  /** One call, with whom it reached and their answers. */
  get(id: string): Promise<CallRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.reinforcementCall.findUnique({ where: { id } });
      if (!row) throw callNotFound();
      return this.read(tx, row, 'field_team');
    });
  }

  /** The calls that reached the technician, newest first. */
  mine(): Promise<CallRead[]> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const reached = await tx.reinforcementCallRecipient.findMany({
        where: { accountId: me },
        select: { callId: true },
      });
      const rows = await tx.reinforcementCall.findMany({
        where: { id: { in: reached.map((r) => r.callId) } },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        take: LIST_MAX,
      });
      const out: CallRead[] = [];
      for (const r of rows) out.push(await this.read(tx, r, 'technician'));
      return out;
    });
  }

  /**
   * A technician it reached accepts, once, while open: a roster slot for
   * the window (ROSTER_OVERLAP refused), the call filled with the last
   * one needed.
   */
  accept(id: string): Promise<CallRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${me}::uuid FOR SHARE`;
      const { call, mine } = await this.answerable(tx, id, me);
      const slotId = await this.duty.writeSlot(tx, {
        technicianId: me,
        startsAt: call.startsAt,
        endsAt: call.endsAt,
        placeId: call.placeId,
        createdById: call.sentById,
        callId: id,
      });
      const now = await dbNow(tx);
      await tx.reinforcementCallRecipient.update({
        where: {
          tenantId_callId_accountId: {
            tenantId: mine.tenantId,
            callId: id,
            accountId: me,
          },
        },
        data: { answer: 'accepted', answeredAt: now, slotId },
      });
      const accepted = call.accepted + 1;
      const filled = accepted >= call.needed;
      const after = await tx.reinforcementCall.update({
        where: { id },
        data: {
          accepted,
          ...(filled ? { status: 'filled', closedAt: now } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'reinforcement_call.accepted',
        targetId: id,
        metadata: { accountId: me, slotId },
      });
      if (filled) {
        await this.audit.record(tx, {
          action: 'reinforcement_call.filled',
          targetId: id,
          metadata: { accepted },
        });
        const to = [
          ...new Set([
            after.sentById,
            ...(await this.staff.holding(tx, 'field_team.manage')).map(
              (r) => r.id,
            ),
          ]),
        ];
        await this.notifier.notify(tx, to, {
          kind: 'reinforcement.filled',
          params: { needed: after.needed },
          targetId: id,
        });
      }
      return this.read(tx, after, 'technician');
    });
  }

  /** A technician it reached declines, once, while open. */
  decline(id: string): Promise<CallRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { call, mine } = await this.answerable(tx, id, me);
      await tx.reinforcementCallRecipient.update({
        where: {
          tenantId_callId_accountId: {
            tenantId: mine.tenantId,
            callId: id,
            accountId: me,
          },
        },
        data: { answer: 'declined', answeredAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'reinforcement_call.declined',
        targetId: id,
        metadata: { accountId: me },
      });
      return this.read(tx, call, 'technician');
    });
  }

  /**
   * Called off once, with a code: the accepted slots nobody filled are
   * cancelled, and whoever it reached and did not decline is told.
   */
  cancel(id: string, reasonCode?: string): Promise<CallRead> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.reinforcementCancel,
    );
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const call = await this.lockCall(tx, id);
      if (!call) throw callNotFound();
      if (call.status !== 'open') throw callClosed(call.status);
      const recipients = await tx.reinforcementCallRecipient.findMany({
        where: { callId: id },
        orderBy: { accountId: 'asc' },
      });
      let slotsCancelled = 0;
      for (const r of recipients)
        if (r.slotId && (await this.duty.cancelSlot(tx, r.slotId, me)))
          slotsCancelled++;
      const after = await tx.reinforcementCall.update({
        where: { id },
        data: {
          status: 'cancelled',
          closedAt: await dbNow(tx),
          cancelledById: me,
          cancelReason: code,
        },
      });
      await this.audit.record(tx, {
        action: 'reinforcement_call.cancelled',
        targetId: id,
        metadata: { reasonCode: code, slotsCancelled },
      });
      const told = recipients
        .filter((r) => r.answer !== 'declined')
        .map((r) => r.accountId);
      if (told.length)
        await this.notifier.notify(tx, told, {
          kind: 'reinforcement.cancelled',
          params: {},
          targetId: id,
        });
      return this.read(tx, after, 'field_team');
    });
  }

  /**
   * Open calls whose start came: closed, once each, under their row
   * (SKIP LOCKED: an answer holding it goes first), as they stand.
   */
  closeStarted(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.reinforcementCall.findMany({
            where: { status: 'open', startsAt: { lte: now } },
            orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
            take: LIST_MAX,
            select: { id: true },
          })
        ).map((r) => r.id),
      async (tx, _tenantId, id) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM reinforcement_calls
           WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const call = await tx.reinforcementCall.findUniqueOrThrow({
          where: { id },
        });
        const at = await dbNow(tx);
        if (call.status !== 'open' || call.startsAt > at) return 0;
        await tx.reinforcementCall.update({
          where: { id },
          data: { status: 'closed', closedAt: at },
        });
        await this.audit.record(tx, {
          action: 'reinforcement_call.closed',
          targetId: id,
          metadata: { accepted: call.accepted },
        });
        return 1;
      },
    );
  }

  // --------------------------------------------------------------------------

  /** The call open, before its start, and the caller reached and unanswered. */
  private async answerable(
    tx: TenantTxClient,
    id: string,
    me: string,
  ): Promise<{ call: ReinforcementCall; mine: ReinforcementCallRecipient }> {
    const call = await this.lockCall(tx, id);
    const mine = call
      ? await tx.reinforcementCallRecipient.findFirst({
          where: { callId: id, accountId: me },
        })
      : null;
    if (!call || !mine) throw callNotFound();
    if (call.status !== 'open' || call.startsAt <= (await dbNow(tx)))
      throw callClosed(call.status === 'open' ? 'closed' : call.status);
    if (mine.answer)
      throw appError.conflict(
        ErrorCode.REINFORCEMENT_ANSWERED,
        'You answered this call already',
        { params: { answer: mine.answer } },
      );
    return { call, mine };
  }

  private async lockCall(
    tx: TenantTxClient,
    id: string,
  ): Promise<ReinforcementCall | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM reinforcement_calls WHERE id = ${id}::uuid FOR UPDATE`;
    return row
      ? tx.reinforcementCall.findUniqueOrThrow({ where: { id } })
      : null;
  }

  private async lockOpenSuggestion(
    tx: TenantTxClient,
    id: string,
  ): Promise<ReinforcementSuggestion> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM reinforcement_suggestions WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw suggestionNotFound();
    const s = await tx.reinforcementSuggestion.findUniqueOrThrow({
      where: { id },
    });
    if (s.status !== 'open')
      throw appError.conflict(
        ErrorCode.REINFORCEMENT_SUGGESTION_DECIDED,
        'This suggestion was decided already',
        { params: { status: s.status } },
      );
    return s;
  }

  private async read(
    tx: TenantTxClient,
    call: ReinforcementCall,
    as: 'field_team' | 'list' | 'technician',
  ): Promise<CallRead> {
    const recipients =
      as === 'field_team'
        ? await tx.reinforcementCallRecipient.findMany({
            where: { callId: call.id },
            orderBy: { accountId: 'asc' },
          })
        : [];
    const people = await this.people(tx, [
      call.sentById,
      ...recipients.map((r) => r.accountId),
    ]);
    const person = (id: string): Person =>
      people.get(id) ?? { id, fullName: null, status: 'erased' };
    const zone = call.placeId
      ? await tx.place.findUnique({
          where: { id: call.placeId },
          select: { id: true, nameEn: true, nameAr: true },
        })
      : null;
    return {
      call,
      sentBy: person(call.sentById),
      zone,
      recipients:
        as === 'field_team'
          ? recipients.map((r) => ({ ...r, person: person(r.accountId) }))
          : null,
      mine:
        as === 'technician'
          ? await tx.reinforcementCallRecipient.findFirst({
              where: { callId: call.id, accountId: this.ctx.accountId },
            })
          : null,
    };
  }

  private async people(
    tx: TenantTxClient,
    ids: readonly (string | null)[],
  ): Promise<Map<string, Person>> {
    const want = [...new Set(ids.filter((x): x is string => x !== null))];
    if (!want.length) return new Map();
    return new Map(
      (
        await tx.account.findMany({
          where: { id: { in: want } },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
  }
}
