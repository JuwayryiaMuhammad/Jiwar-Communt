import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  BoardMeeting,
  BoardMeetingAction,
  BoardMeetingAgendaItem,
} from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
import { PermissionsService } from '../../core/access/permissions.service';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { GovernanceAccess, type Author } from '../access';
import { BoardService } from '../board/board.service';
import { nextGovernanceNumber } from '../counters';
import { asDate, dbNow, fromDate } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import {
  MEETING_LIMITS,
  quorumOf,
  type ActionStatus,
  type AgendaItemKind,
  type MeetingKind,
  type MeetingStatus,
} from './meeting-rules';

export const BOARD_ACTIONS_SWEEP = 'governance.board_actions';
const SWEEP_INTERVAL_MS = 15 * 60_000;
const MS_PER_DAY = 86_400_000;
const PAGE = keysetCursor('scheduledAt', 'desc');
const ACTION_PAGE = keysetCursor('createdAt', 'desc');

export interface AgendaInput {
  kind: AgendaItemKind;
  subjectId?: string;
  title?: string;
}

export interface MeetingFields {
  kind?: MeetingKind;
  title?: string;
  location?: string | null;
  scheduledAt?: Date;
  agenda?: AgendaInput[];
}

export interface NewMeeting extends MeetingFields {
  kind: MeetingKind;
  title: string;
  scheduledAt: Date;
}

/** One agenda item as the board reads it: its subject's reference and state. */
export interface AgendaItemRecord {
  position: number;
  kind: AgendaItemKind;
  subjectId: string | null;
  /** `AR-0001`, `BA-0001`; null for a proposal or an item of its own. */
  reference: string | null;
  /** The subject's status now; null for an item of its own. */
  subjectStatus: string | null;
  /** The item's own words, or the proposal's title. */
  title: string | null;
}

export interface AttendanceRecord {
  memberId: string;
  accountId: string;
  fullName: string | null;
  role: string;
  present: boolean;
}

export interface ActionRecord {
  action: BoardMeetingAction;
  meetingNumber: number;
  ownerName: string | null;
  /** Open past its due day, by the compound's day. */
  overdue: boolean;
}

export interface MeetingRecord {
  meeting: BoardMeeting;
  agenda: AgendaItemRecord[];
  attendance: AttendanceRecord[];
  actions: ActionRecord[];
  /** Open action items of the same board's earlier meetings: what to follow up. */
  followUp: ActionRecord[];
}

const meetingNotFound = () =>
  appError.notFound(ErrorCode.BOARD_MEETING_NOT_FOUND, 'Meeting not found');
const actionNotFound = () =>
  appError.notFound(
    ErrorCode.BOARD_MEETING_ACTION_NOT_FOUND,
    'Action item not found',
  );
const notScheduled = (status: string) =>
  appError.conflict(
    ErrorCode.BOARD_MEETING_NOT_SCHEDULED,
    'Only a scheduled meeting changes',
    { params: { status } },
  );
const notHeld = (status: string) =>
  appError.conflict(
    ErrorCode.BOARD_MEETING_NOT_HELD,
    'The meeting has not been held',
    { params: { status } },
  );
const boardGone = () =>
  appError.conflict(
    ErrorCode.BOARD_MEETING_BOARD_GONE,
    'The board that scheduled the meeting no longer sits',
  );
const actionClosed = (status: string) =>
  appError.conflict(
    ErrorCode.BOARD_MEETING_ACTION_CLOSED,
    'The action item is done or cancelled already',
    { params: { status } },
  );

/**
 * Board meetings (ADR 0075). A sitting member, or the manager, schedules a
 * meeting of the board that sits, with its agenda; changes it while it is
 * scheduled; records it held once, with who of the seats sitting then was
 * there and whether that made the board's quorum; or cancels it once with
 * a code. Once held, its minutes are linked (a board publication of kind
 * `minutes`, published as ADR 0051 says, once) and its action items are
 * written, each with an owner (a sitting member or the manager) and a due
 * day; the owner is told, and told again once when it runs past its day.
 * A meeting's record shows the open items of the same board's earlier
 * meetings, to follow them up. The owners never read meetings: what they
 * read is the minutes.
 *
 * Lock order (ADR 0051, 0055): the caller's account, the accounts it tells
 * (key-shared), the caller's seat; for a hold the term and its seats
 * shared; then the meeting row, then an action item.
 */
@Injectable()
export class MeetingsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly board: BoardService,
    private readonly community: CommunityGovernancePort,
    private readonly notices: GovernanceNotices,
    private readonly audit: AuditService,
    private readonly settings: TenantSettingsService,
    private readonly sweep: SweepRunner,
    private readonly permissions: PermissionsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(BOARD_ACTIONS_SWEEP, (now) => this.runSweep(now), {
      intervalMs: SWEEP_INTERVAL_MS,
    });
  }

  // --------------------------------------------------------------------------
  // Reading: the board and the manager
  // --------------------------------------------------------------------------

  list(q: {
    status?: MeetingStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<BoardMeeting>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.boardMeeting.findMany({
        where: {
          AND: [q.status ? { status: q.status } : {}, ...PAGE.after(q.cursor)],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<MeetingRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const meeting = await tx.boardMeeting.findUnique({ where: { id } });
      if (!meeting) throw meetingNotFound();
      return this.load(tx, meeting);
    });
  }

  /** Action items across meetings: open ones to follow up, or the caller's own. */
  actions(q: {
    status?: ActionStatus;
    mine?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ActionRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.boardMeetingAction.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.mine ? { ownerId: this.ctx.accountId } : {},
            ...ACTION_PAGE.after(q.cursor),
          ],
        },
        orderBy: ACTION_PAGE.orderBy,
        take: limit + 1,
      });
      const page = ACTION_PAGE.toPage(rows, limit);
      return {
        items: await this.actionRecords(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Writing: a sitting member, or the manager
  // --------------------------------------------------------------------------

  schedule(input: NewMeeting): Promise<MeetingRecord> {
    const fields = [
      ...fieldProblems(input),
      ...agendaProblems(input.agenda ?? []),
    ];
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const now = await dbNow(tx);
      // Accounts first: the board it tells.
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, now),
      );
      const author = await this.access.requireAuthor(tx);
      const termId = await this.sittingTerm(tx, author);
      const when = windowProblems(input.scheduledAt, await dbNow(tx));
      if (when.length) throw invalid(when);
      await this.checkSubjects(tx, input.agenda ?? []);
      const id = newId();
      const meeting = await tx.boardMeeting.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          termId,
          number: await nextGovernanceNumber(
            tx,
            this.ctx.txTenantId,
            'meeting',
          ),
          kind: input.kind,
          title: input.title.trim(),
          location: input.location?.trim() || null,
          scheduledAt: input.scheduledAt,
          authorSide: author.side,
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.writeAgenda(tx, id, input.agenda ?? []);
      await this.audit.record(tx, {
        action: 'board_meeting.scheduled',
        targetId: id,
        changes: diffChanges(
          null,
          audited(meeting, (input.agenda ?? []).length),
          'board_meeting.scheduled',
        ),
        metadata: { side: author.side },
      });
      const seated = await this.board.seatedAccounts(tx, await dbNow(tx));
      await this.access.lockLate(tx, seated);
      await this.notices.send(
        tx,
        seated.filter((a) => a !== this.ctx.accountId),
        'board_meeting.scheduled',
        id,
        { kind: meeting.kind },
      );
      return this.load(tx, meeting);
    });
  }

  /** While scheduled: its kind, title, place, time, and its agenda as a whole. */
  update(id: string, input: MeetingFields): Promise<MeetingRecord> {
    const fields = [
      ...fieldProblems(input),
      ...(input.agenda ? agendaProblems(input.agenda) : []),
    ];
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const author = await this.access.requireAuthor(tx);
      const meeting = await this.lockMeeting(tx, id);
      await this.requireOwnBoard(tx, author, meeting);
      if (meeting.status !== 'scheduled') throw notScheduled(meeting.status);
      if (input.scheduledAt) {
        const when = windowProblems(input.scheduledAt, await dbNow(tx));
        if (when.length) throw invalid(when);
      }
      if (input.agenda) await this.checkSubjects(tx, input.agenda);
      const before = audited(meeting, await this.agendaCount(tx, id));
      const updated = await tx.boardMeeting.update({
        where: { id },
        data: {
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.location !== undefined
            ? { location: input.location?.trim() || null }
            : {}),
          ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        },
      });
      if (input.agenda) {
        await tx.boardMeetingAgendaItem.deleteMany({
          where: { meetingId: id },
        });
        await this.writeAgenda(tx, id, input.agenda);
      }
      const changes = diffChanges(
        before,
        audited(updated, await this.agendaCount(tx, id)),
        'board_meeting.changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'board_meeting.changed',
          targetId: id,
          changes,
        });
      return this.load(tx, updated);
    });
  }

  /**
   * Held, once: who of the seats sitting now was present. The term and its
   * seats are locked shared first, so nobody is seated or unseated while
   * the attendance is written; the quorum is more than half of them.
   */
  hold(
    id: string,
    input: { presentMemberIds: string[] },
  ): Promise<MeetingRecord> {
    const present = new Set(input.presentMemberIds);
    if (present.size !== input.presentMemberIds.length)
      throw invalid([
        {
          field: 'presentMemberIds',
          code: FieldErrorCode.DUPLICATE_VALUE,
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const author = await this.access.requireAuthor(tx);
      const seen = await tx.boardMeeting.findUnique({ where: { id } });
      if (!seen) throw meetingNotFound();
      const seats = await this.access.lockBoardForVote(tx, seen.termId);
      const meeting = await this.lockMeeting(tx, id);
      await this.requireOwnBoard(tx, author, meeting);
      if (meeting.status !== 'scheduled') throw notScheduled(meeting.status);
      const seatIds = new Set(seats.map((s) => s.memberId));
      const strangers = input.presentMemberIds
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => !seatIds.has(m))
        .map(({ i }) => ({
          field: `presentMemberIds.${i}`,
          code: FieldErrorCode.INVALID_VALUE,
        }));
      if (strangers.length) throw invalid(strangers);
      const now = await dbNow(tx);
      if (seats.length)
        await tx.boardMeetingAttendance.createMany({
          data: seats.map((s) => ({
            tenantId: this.ctx.txTenantId,
            meetingId: id,
            memberId: s.memberId,
            present: present.has(s.memberId),
          })),
        });
      const quorate = present.size >= quorumOf(seats.length);
      const held = await tx.boardMeeting.update({
        where: { id },
        data: {
          status: 'held',
          heldAt: now,
          seatedCount: seats.length,
          presentCount: present.size,
          quorate,
        },
      });
      await this.audit.record(tx, {
        action: 'board_meeting.held',
        targetId: id,
        metadata: {
          seated: seats.length,
          present: present.size,
          quorate,
          side: author.side,
        },
      });
      return this.load(tx, held);
    });
  }

  /** Cancelled, once, with its code; the board is told. */
  cancel(id: string, input: { reasonCode?: string }): Promise<MeetingRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.boardMeetingCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const now = await dbNow(tx);
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, now),
      );
      const author = await this.access.requireAuthor(tx);
      const meeting = await this.lockMeeting(tx, id);
      await this.requireOwnBoard(tx, author, meeting);
      if (meeting.status !== 'scheduled') throw notScheduled(meeting.status);
      const cancelled = await tx.boardMeeting.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: await dbNow(tx),
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'board_meeting.cancelled',
        targetId: id,
        metadata: { reasonCode: reason, side: author.side },
      });
      const seated = await this.board.seatedAccounts(tx, await dbNow(tx));
      await this.access.lockLate(tx, seated);
      await this.notices.send(
        tx,
        seated.filter((a) => a !== this.ctx.accountId),
        'board_meeting.cancelled',
        id,
        { reason },
      );
      return this.load(tx, cancelled);
    });
  }

  /**
   * The minutes of a held meeting: a board publication of kind `minutes`
   * of the same board, not archived, linked to no other meeting; once.
   */
  linkMinutes(
    id: string,
    input: { publicationId: string },
  ): Promise<MeetingRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.requireAuthor(tx);
      const meeting = await this.lockMeeting(tx, id);
      if (meeting.status !== 'held') throw notHeld(meeting.status);
      if (meeting.minutesPublicationId)
        throw appError.conflict(
          ErrorCode.BOARD_MEETING_MINUTES_LINKED,
          'The meeting’s minutes are linked already',
          { params: { publicationId: meeting.minutesPublicationId } },
        );
      const publication = await tx.boardPublication.findUnique({
        where: { id: input.publicationId },
      });
      const taken =
        publication &&
        (await tx.boardMeeting.findFirst({
          where: { minutesPublicationId: publication.id },
          select: { id: true },
        }));
      if (
        !publication ||
        publication.kind !== 'minutes' ||
        publication.termId !== meeting.termId ||
        publication.archivedAt !== null ||
        taken
      )
        throw invalid([
          { field: 'publicationId', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const linked = await tx.boardMeeting.update({
        where: { id },
        data: { minutesPublicationId: publication.id },
      });
      await this.audit.record(tx, {
        action: 'board_meeting.minutes_linked',
        targetId: id,
        metadata: { publicationId: publication.id },
      });
      return this.load(tx, linked);
    });
  }

  /**
   * An action item of a held meeting: its owner a sitting member of the
   * meeting's board or an active manager, due today to a year ahead (the
   * compound's day). The owner is told, unless they wrote it.
   */
  addAction(
    meetingId: string,
    input: { title: string; ownerAccountId: string; dueOn: string },
  ): Promise<ActionRecord> {
    const title = input.title.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockAccounts(tx, [input.ownerAccountId]);
      await this.access.requireAuthor(tx);
      const meeting = await this.lockMeeting(tx, meetingId);
      if (meeting.status !== 'held') throw notHeld(meeting.status);
      if (!(await this.mayOwn(tx, meeting.termId, input.ownerAccountId)))
        throw invalid([
          { field: 'ownerAccountId', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const today = await this.today(tx, this.ctx.txTenantId);
      if (
        input.dueOn < today ||
        input.dueOn > addDays(today, MEETING_LIMITS.dueAheadDays)
      )
        throw invalid([
          {
            field: 'dueOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { from: today, maxDays: MEETING_LIMITS.dueAheadDays },
          },
        ]);
      const id = newId();
      const action = await tx.boardMeetingAction.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          meetingId,
          title,
          ownerId: input.ownerAccountId,
          dueOn: asDate(input.dueOn),
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'board_meeting_action.created',
        targetId: id,
        changes: diffChanges(
          null,
          {
            meetingId,
            ownerId: input.ownerAccountId,
            dueOn: input.dueOn,
            title,
          },
          'board_meeting_action.created',
        ),
      });
      if (input.ownerAccountId !== this.ctx.accountId)
        await this.notices.send(
          tx,
          [input.ownerAccountId],
          'board_meeting_action.assigned',
          id,
        );
      return (await this.actionRecords(tx, [action]))[0];
    });
  }

  /** Done, once, with an optional note: its owner, a sitting member or the manager. */
  completeAction(id: string, input: { note?: string }): Promise<ActionRecord> {
    const note = input.note?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.boardMeetingAction.findUnique({ where: { id } });
      if (!seen) throw actionNotFound();
      if (seen.ownerId !== this.ctx.accountId) {
        const mayAct =
          (await this.permissions.has('governance.manage')) ||
          (await this.access.lockSeat(tx, this.ctx.accountId)) !== null;
        if (!mayAct)
          throw appError.forbidden(
            ErrorCode.BOARD_MEETING_ACTION_NOT_YOURS,
            'Only its owner, a sitting member or the manager marks it done',
          );
      }
      const action = await this.lockAction(tx, id);
      if (action.status !== 'open') throw actionClosed(action.status);
      const done = await tx.boardMeetingAction.update({
        where: { id },
        data: {
          status: 'done',
          doneAt: await dbNow(tx),
          doneById: this.ctx.accountId,
          doneNote: note,
        },
      });
      await this.audit.record(tx, {
        action: 'board_meeting_action.done',
        targetId: id,
        metadata: {
          note: note !== null,
          byOwner: seen.ownerId === this.ctx.accountId,
        },
      });
      return (await this.actionRecords(tx, [done]))[0];
    });
  }

  /** Cancelled, once, with its code: a sitting member or the manager. */
  cancelAction(
    id: string,
    input: { reasonCode?: string },
  ): Promise<ActionRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.boardActionCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.requireAuthor(tx);
      const action = await this.lockAction(tx, id);
      if (action.status !== 'open') throw actionClosed(action.status);
      const cancelled = await tx.boardMeetingAction.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: await dbNow(tx),
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'board_meeting_action.cancelled',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      return (await this.actionRecords(tx, [cancelled]))[0];
    });
  }

  // --------------------------------------------------------------------------
  // The sweep: an open item past its day tells its owner, once
  // --------------------------------------------------------------------------

  async runSweep(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const today = await this.today(tx, tenantId, now);
        return (
          await tx.boardMeetingAction.findMany({
            where: {
              status: 'open',
              overdueNotifiedAt: null,
              dueOn: { lt: asDate(today) },
            },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 500,
          })
        ).map((a) => a.id);
      },
      (tx, _tenantId, id) => this.notifyOverdue(tx, id, now),
    );
  }

  private async notifyOverdue(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<number> {
    const seen = await tx.boardMeetingAction.findUnique({ where: { id } });
    if (!seen) return 0;
    await this.access.lockAccounts(tx, [seen.ownerId]);
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM board_meeting_actions
       WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
    if (!row) return 0;
    const { count } = await tx.boardMeetingAction.updateMany({
      where: { id, status: 'open', overdueNotifiedAt: null },
      data: { overdueNotifiedAt: now },
    });
    if (!count) return 0;
    await this.notices.send(
      tx,
      [seen.ownerId],
      'board_meeting_action.overdue',
      id,
    );
    return 1;
  }

  // --------------------------------------------------------------------------

  /** The term the author acts for: the board sitting now (409 when none). */
  private async sittingTerm(
    tx: TenantTxClient,
    author: Author,
  ): Promise<string> {
    if (author.side === 'board') return author.termId;
    const board = await this.board.sitting(tx, await dbNow(tx));
    if (!board)
      throw appError.conflict(
        ErrorCode.BOARD_NOT_SITTING,
        'No board sits: a meeting is of the board that sits',
      );
    return board.term.id;
  }

  /** A member acts only on their own board's meetings; the manager on any. */
  private async requireOwnBoard(
    tx: TenantTxClient,
    author: Author,
    meeting: BoardMeeting,
  ): Promise<void> {
    if (author.side === 'board') {
      if (author.termId !== meeting.termId) throw boardGone();
      return;
    }
    const sitting = await this.board.sitting(tx, await dbNow(tx));
    if (sitting?.term.id !== meeting.termId) throw boardGone();
  }

  /** A sitting member of the meeting's board, or an active manager. */
  private async mayOwn(
    tx: TenantTxClient,
    termId: string,
    accountId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM board_members m
         WHERE m.term_id = ${termId}::uuid AND m.account_id = ${accountId}::uuid
           AND m.ended_at IS NULL
      ) OR EXISTS (
        SELECT 1 FROM accounts a
         WHERE a.id = ${accountId}::uuid AND a.type::text = 'manager'
           AND a.status::text = 'active'
      ) AS ok`;
    return rows[0]?.ok ?? false;
  }

  /** Every subject named is a matter the board still has before it. */
  private async checkSubjects(
    tx: TenantTxClient,
    agenda: AgendaInput[],
  ): Promise<void> {
    const errors: FieldError[] = [];
    for (const [i, item] of agenda.entries()) {
      if (item.kind === 'other' || !item.subjectId) continue;
      const open =
        item.kind === 'approval_request'
          ? (
              await tx.governanceApprovalRequest.findUnique({
                where: { id: item.subjectId },
                select: { status: true },
              })
            )?.status === 'pending'
          : item.kind === 'board_appeal'
            ? (
                await tx.governanceBoardAppeal.findUnique({
                  where: { id: item.subjectId },
                  select: { status: true },
                })
              )?.status === 'pending'
            : (
                await tx.governanceAgendaProposal.findUnique({
                  where: { id: item.subjectId },
                  select: { status: true },
                })
              )?.status === 'open';
      if (!open)
        errors.push({
          field: `agenda.${i}.subjectId`,
          code: FieldErrorCode.INVALID_VALUE,
        });
    }
    if (errors.length) throw invalid(errors);
  }

  private async writeAgenda(
    tx: TenantTxClient,
    meetingId: string,
    agenda: AgendaInput[],
  ): Promise<void> {
    if (!agenda.length) return;
    await tx.boardMeetingAgendaItem.createMany({
      data: agenda.map((item, i) => ({
        tenantId: this.ctx.txTenantId,
        meetingId,
        position: i + 1,
        kind: item.kind,
        approvalRequestId:
          item.kind === 'approval_request' ? item.subjectId! : null,
        boardAppealId: item.kind === 'board_appeal' ? item.subjectId! : null,
        agendaProposalId:
          item.kind === 'agenda_proposal' ? item.subjectId! : null,
        title: item.kind === 'other' ? item.title!.trim() : null,
      })),
    });
  }

  private agendaCount(tx: TenantTxClient, meetingId: string): Promise<number> {
    return tx.boardMeetingAgendaItem.count({ where: { meetingId } });
  }

  private async lockMeeting(
    tx: TenantTxClient,
    id: string,
  ): Promise<BoardMeeting> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM board_meetings WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw meetingNotFound();
    return tx.boardMeeting.findUniqueOrThrow({ where: { id } });
  }

  private async lockAction(
    tx: TenantTxClient,
    id: string,
  ): Promise<BoardMeetingAction> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM board_meeting_actions WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw actionNotFound();
    return tx.boardMeetingAction.findUniqueOrThrow({ where: { id } });
  }

  private async today(
    tx: TenantTxClient,
    tenantId: string,
    now?: Date,
  ): Promise<string> {
    const { timezone } = await this.settings.inTx(tx, tenantId);
    return localDate(now ?? (await dbNow(tx)), timezone);
  }

  private async load(
    tx: TenantTxClient,
    meeting: BoardMeeting,
  ): Promise<MeetingRecord> {
    const items = await tx.boardMeetingAgendaItem.findMany({
      where: { meetingId: meeting.id },
      orderBy: { position: 'asc' },
    });
    const attendance = await tx.boardMeetingAttendance.findMany({
      where: { meetingId: meeting.id },
    });
    const seats = attendance.length
      ? await tx.boardMember.findMany({
          where: { id: { in: attendance.map((a) => a.memberId) } },
        })
      : [];
    const names = await this.community.names(
      tx,
      seats.map((s) => s.accountId),
    );
    const actions = await tx.boardMeetingAction.findMany({
      where: { meetingId: meeting.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const earlier = await tx.boardMeeting.findMany({
      where: {
        termId: meeting.termId,
        status: 'held',
        id: { not: meeting.id },
        scheduledAt: { lt: meeting.scheduledAt },
      },
      select: { id: true },
    });
    const followUp = earlier.length
      ? await tx.boardMeetingAction.findMany({
          where: {
            meetingId: { in: earlier.map((m) => m.id) },
            status: 'open',
          },
          orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
        })
      : [];
    return {
      meeting,
      agenda: await this.agendaRecords(tx, items),
      attendance: attendance
        .map((a) => {
          const seat = seats.find((s) => s.id === a.memberId)!;
          return {
            memberId: a.memberId,
            accountId: seat.accountId,
            fullName: names.get(seat.accountId) ?? null,
            role: seat.role,
            present: a.present,
          };
        })
        .sort((a, b) => (a.memberId < b.memberId ? -1 : 1)),
      actions: await this.actionRecords(tx, actions),
      followUp: await this.actionRecords(tx, followUp),
    };
  }

  private async agendaRecords(
    tx: TenantTxClient,
    items: BoardMeetingAgendaItem[],
  ): Promise<AgendaItemRecord[]> {
    const out: AgendaItemRecord[] = [];
    for (const item of items) {
      const base = {
        position: item.position,
        kind: item.kind as AgendaItemKind,
      };
      if (item.approvalRequestId) {
        const r = await tx.governanceApprovalRequest.findUniqueOrThrow({
          where: { id: item.approvalRequestId },
          select: { number: true, status: true },
        });
        out.push({
          ...base,
          subjectId: item.approvalRequestId,
          reference: `AR-${String(r.number).padStart(4, '0')}`,
          subjectStatus: r.status,
          title: null,
        });
      } else if (item.boardAppealId) {
        const a = await tx.governanceBoardAppeal.findUniqueOrThrow({
          where: { id: item.boardAppealId },
          select: { number: true, status: true },
        });
        out.push({
          ...base,
          subjectId: item.boardAppealId,
          reference: `BA-${String(a.number).padStart(4, '0')}`,
          subjectStatus: a.status,
          title: null,
        });
      } else if (item.agendaProposalId) {
        const p = await tx.governanceAgendaProposal.findUniqueOrThrow({
          where: { id: item.agendaProposalId },
          select: { title: true, status: true },
        });
        out.push({
          ...base,
          subjectId: item.agendaProposalId,
          reference: null,
          subjectStatus: p.status,
          title: p.title,
        });
      } else
        out.push({
          ...base,
          subjectId: null,
          reference: null,
          subjectStatus: null,
          title: item.title,
        });
    }
    return out;
  }

  private async actionRecords(
    tx: TenantTxClient,
    actions: BoardMeetingAction[],
  ): Promise<ActionRecord[]> {
    if (!actions.length) return [];
    const meetings = new Map(
      (
        await tx.boardMeeting.findMany({
          where: { id: { in: [...new Set(actions.map((a) => a.meetingId))] } },
          select: { id: true, number: true },
        })
      ).map((m) => [m.id, m.number]),
    );
    const names = await this.community.names(
      tx,
      actions.map((a) => a.ownerId),
    );
    const today = await this.today(tx, this.ctx.txTenantId);
    return actions.map((action) => ({
      action,
      meetingNumber: meetings.get(action.meetingId) ?? 0,
      ownerName: names.get(action.ownerId) ?? null,
      overdue: action.status === 'open' && fromDate(action.dueOn) < today,
    }));
  }
}

/** What the audit trail records of a meeting: its terms by value, its words as "changed". */
function audited(m: BoardMeeting, agenda: number): Record<string, unknown> {
  return {
    number: m.number,
    kind: m.kind,
    scheduledAt: m.scheduledAt.toISOString(),
    agenda,
    title: m.title,
    location: m.location,
  };
}

function fieldProblems(input: MeetingFields): FieldError[] {
  const out: FieldError[] = [];
  const text = (
    field: 'title' | 'location',
    value: string | null | undefined,
  ) => {
    if (value === undefined || value === null) return;
    const v = value.trim();
    const max = MEETING_LIMITS[field];
    if (v.length < 1 || v.length > max)
      out.push({
        field,
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max },
      });
  };
  text('title', input.title);
  text('location', input.location);
  return out;
}

function agendaProblems(agenda: AgendaInput[]): FieldError[] {
  const out: FieldError[] = [];
  if (agenda.length > MEETING_LIMITS.agendaItems)
    out.push({
      field: 'agenda',
      code: FieldErrorCode.INVALID_LENGTH,
      params: { min: 0, max: MEETING_LIMITS.agendaItems },
    });
  const seen = new Set<string>();
  agenda.forEach((item, i) => {
    const own = item.kind === 'other';
    if (own && item.subjectId)
      out.push({
        field: `agenda.${i}.subjectId`,
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (!own && !item.subjectId)
      out.push({
        field: `agenda.${i}.subjectId`,
        code: FieldErrorCode.FIELD_REQUIRED,
      });
    if (!own && item.title !== undefined)
      out.push({
        field: `agenda.${i}.title`,
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (own) {
      const t = item.title?.trim() ?? '';
      if (t.length < 1 || t.length > MEETING_LIMITS.agendaTitle)
        out.push({
          field: `agenda.${i}.title`,
          code:
            item.title === undefined
              ? FieldErrorCode.FIELD_REQUIRED
              : FieldErrorCode.INVALID_LENGTH,
          ...(item.title === undefined
            ? {}
            : { params: { min: 1, max: MEETING_LIMITS.agendaTitle } }),
        });
    }
    if (item.subjectId && !own) {
      if (seen.has(item.subjectId))
        out.push({
          field: `agenda.${i}.subjectId`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      seen.add(item.subjectId);
    }
  });
  return out;
}

/** At most 30 days back (recorded after the fact) and a year ahead. */
function windowProblems(at: Date, now: Date): FieldError[] {
  const from = now.getTime() - MEETING_LIMITS.backDays * MS_PER_DAY;
  const to = now.getTime() + MEETING_LIMITS.aheadDays * MS_PER_DAY;
  return at.getTime() < from || at.getTime() > to
    ? [
        {
          field: 'scheduledAt',
          code: FieldErrorCode.INVALID_VALUE,
          params: {
            maxDaysBack: MEETING_LIMITS.backDays,
            maxDaysAhead: MEETING_LIMITS.aheadDays,
          },
        },
      ]
    : [];
}
