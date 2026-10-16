import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BoardMember, BoardRole, BoardTerm } from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
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
import { GovernanceAccess } from '../access';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import {
  APPOINTED_TERM_DAYS,
  BOARD_SEATS,
  doubledOffice,
  termStatus,
  type TermStatus,
} from './board-rules';

export const BOARD_TERM_RESOURCE = 'board_term';
const DAY_MS = 86_400_000;
const PAGE = keysetCursor('startsAt', 'desc');

export type BoardMemberEndReason =
  | (typeof REASON_CODES.boardMemberEnd)[number]
  | (typeof REASON_CODES.boardMemberSystemEnd)[number];

export interface SeatRecord extends BoardMember {
  fullName: string | null;
}

export interface TermRecord {
  term: BoardTerm;
  status: TermStatus;
  /** Every seat of the term, ended ones too, oldest first. */
  members: SeatRecord[];
}

export interface Appointment {
  seats: number;
  endsAt: Date;
  members: { accountId: string; role: BoardRole }[];
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const notSitting = () =>
  appError.conflict(ErrorCode.BOARD_NOT_SITTING, 'No board sits now');

export const memberNotFound = () =>
  appError.notFound(ErrorCode.BOARD_MEMBER_NOT_FOUND, 'Board member not found');

/**
 * The owners' board (ADR 0051): its terms and seats. The manager appoints
 * a board when none sits, fills a vacant seat, assigns the offices and
 * ends a seat; an election's certification seats the next board. Every
 * write takes the compound's board lock, so the open-term, one-seat and
 * one-office rules are decided one write at a time (the unique indexes are
 * the backstop).
 */
@Injectable()
export class BoardService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly community: CommunityGovernancePort,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notices: GovernanceNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(BOARD_TERM_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const term = await tx.boardTerm.findUniqueOrThrow({ where: { id } });
        return { id: term.id, startsAt: term.startsAt };
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  /** The board sitting now, for an owner; null when none sits. */
  ownersBoard(): Promise<TermRecord | null> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.requireOwner(tx);
      return this.sitting(tx, await dbNow(tx));
    });
  }

  /** The board's terms, newest first, for an owner. */
  ownersTerms(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<TermRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.requireOwner(tx);
      return this.terms(tx, q);
    });
  }

  /** The open term (current or lapsed), for the manager; null when none. */
  staffBoard(): Promise<TermRecord | null> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const term = await tx.boardTerm.findFirst({ where: { endedAt: null } });
      return term ? this.load(tx, term, await dbNow(tx)) : null;
    });
  }

  staffTerms(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<TermRecord>> {
    return this.tenantTx.withTenantTx((tx) => this.terms(tx, q));
  }

  /** The term sitting now, or null (none, or the open one lapsed). */
  async sitting(tx: TenantTxClient, now: Date): Promise<TermRecord | null> {
    const term = await tx.boardTerm.findFirst({
      where: { endedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    });
    return term ? this.load(tx, term, now) : null;
  }

  /** The seated accounts of the board sitting now. */
  async seatedAccounts(tx: TenantTxClient, now: Date): Promise<string[]> {
    const board = await this.sitting(tx, now);
    return board
      ? board.members.filter((m) => !m.endedAt).map((m) => m.accountId)
      : [];
  }

  private async terms(
    tx: TenantTxClient,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<TermRecord>> {
    const limit = clampLimit(q.limit);
    const now = await dbNow(tx);
    const rows = await tx.boardTerm.findMany({
      where: { AND: PAGE.after(q.cursor) },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    const page = PAGE.toPage(rows, limit);
    const items: TermRecord[] = [];
    for (const term of page.items) items.push(await this.load(tx, term, now));
    return { items, nextCursor: page.nextCursor };
  }

  private async load(
    tx: TenantTxClient,
    term: BoardTerm,
    now: Date,
  ): Promise<TermRecord> {
    const seats = await tx.boardMember.findMany({
      where: { termId: term.id },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
    const names = await this.community.names(
      tx,
      seats.map((s) => s.accountId),
    );
    return {
      term,
      status: termStatus(term, now),
      members: seats.map((s) => ({
        ...s,
        fullName: names.get(s.accountId) ?? null,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // The manager's writes
  // --------------------------------------------------------------------------

  /**
   * Seats a board when none sits: the first one, or after the open term
   * lapsed (which ends now, `replaced`). Never over a sitting board.
   */
  appoint(input: Appointment): Promise<TermRecord> {
    const fields = checkAppointment(input);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockBoard(tx);
      const now = await dbNow(tx);
      const open = await tx.boardTerm.findFirst({ where: { endedAt: null } });
      if (open && termStatus(open, now) === 'current')
        throw appError.conflict(ErrorCode.BOARD_SITTING, 'A board sits now', {
          params: { endsAt: open.endsAt.toISOString() },
        });
      const days = (input.endsAt.getTime() - now.getTime()) / DAY_MS;
      if (days < APPOINTED_TERM_DAYS.min || days > APPOINTED_TERM_DAYS.max)
        throw invalid([
          {
            field: 'endsAt',
            code: FieldErrorCode.INVALID_VALUE,
            params: {
              minDays: APPOINTED_TERM_DAYS.min,
              maxDays: APPOINTED_TERM_DAYS.max,
            },
          },
        ]);
      const notOwners: FieldError[] = [];
      for (const [i, m] of input.members.entries())
        if (!(await this.community.isOwner(tx, m.accountId)))
          notOwners.push({
            field: `members.${i}.accountId`,
            code: FieldErrorCode.OWNER_NOT_ELIGIBLE,
          });
      if (notOwners.length) throw invalid(notOwners);

      const id = newId();
      await this.idempotency.claim(tx, { type: BOARD_TERM_RESOURCE, id });
      if (open) await this.endTerm(tx, open, now, 'replaced', id);
      const term = await tx.boardTerm.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          source: 'appointed',
          seats: input.seats,
          startsAt: now,
          endsAt: input.endsAt,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'board_term.appointed',
        targetId: id,
        metadata: {
          seats: input.seats,
          startsAt: now.toISOString(),
          endsAt: input.endsAt.toISOString(),
          members: input.members.map((m) => ({
            accountId: m.accountId,
            role: m.role,
          })),
          lapsedTermId: open?.id ?? null,
        },
      });
      for (const m of input.members)
        await this.seat(tx, term, m.accountId, m.role, now, 'appointed');
      return this.load(tx, term, now);
    });
  }

  /** Fills a vacant seat of the board sitting now. */
  addMember(input: {
    accountId: string;
    role: BoardRole;
  }): Promise<TermRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockBoard(tx);
      const now = await dbNow(tx);
      const board = await this.sitting(tx, now);
      if (!board) throw notSitting();
      const seated = board.members.filter((m) => !m.endedAt);
      if (seated.some((m) => m.accountId === input.accountId))
        throw appError.conflict(
          ErrorCode.BOARD_ALREADY_SEATED,
          'The owner sits on the board already',
        );
      if (seated.length >= board.term.seats)
        throw appError.conflict(
          ErrorCode.BOARD_SEATS_FULL,
          'Every seat of the board is taken',
          { params: { seats: board.term.seats } },
        );
      this.officeFree(seated, input.role);
      if (!(await this.community.isOwner(tx, input.accountId)))
        throw invalid([
          { field: 'accountId', code: FieldErrorCode.OWNER_NOT_ELIGIBLE },
        ]);
      await this.seat(
        tx,
        board.term,
        input.accountId,
        input.role,
        now,
        'appointed',
      );
      return this.load(tx, board.term, now);
    });
  }

  /** Gives a seated member of the board sitting now another role. */
  changeRole(memberId: string, role: BoardRole): Promise<TermRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockBoard(tx);
      const now = await dbNow(tx);
      const board = await this.sitting(tx, now);
      const seated = board?.members.filter((m) => !m.endedAt) ?? [];
      const member = seated.find((m) => m.id === memberId);
      if (!board || !member) throw memberNotFound();
      if (member.role === role) return board;
      this.officeFree(
        seated.filter((m) => m.id !== memberId),
        role,
      );
      await tx.boardMember.update({ where: { id: memberId }, data: { role } });
      await this.audit.record(tx, {
        action: 'board_member.role_changed',
        targetId: memberId,
        metadata: {
          termId: board.term.id,
          accountId: member.accountId,
          from: member.role,
          to: role,
        },
      });
      return this.load(tx, board.term, now);
    });
  }

  /** Ends a seat of the board sitting now, with a reason's code. */
  endMember(
    memberId: string,
    reasonCode: string | undefined,
  ): Promise<TermRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.boardMemberEnd,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockBoard(tx);
      const now = await dbNow(tx);
      const board = await this.sitting(tx, now);
      const member = board?.members.find(
        (m) => m.id === memberId && !m.endedAt,
      );
      if (!board || !member) throw memberNotFound();
      await this.endSeat(tx, member, now, reason, this.ctx.accountId);
      return this.load(tx, board.term, now);
    });
  }

  // --------------------------------------------------------------------------
  // For the rest of governance (certification, the lifecycle)
  // --------------------------------------------------------------------------

  /** A seat in `term`, told to its holder. The board lock is held. */
  async seat(
    tx: TenantTxClient,
    term: BoardTerm,
    accountId: string,
    role: BoardRole,
    now: Date,
    source: 'appointed' | 'elected',
  ): Promise<void> {
    const id = newId();
    await tx.boardMember.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        termId: term.id,
        accountId,
        role,
        addedAt: now,
        addedById: this.ctx.accountId,
      },
    });
    await this.audit.record(tx, {
      action: 'board_member.added',
      targetId: id,
      metadata: { termId: term.id, accountId, role, source },
    });
    await this.notices.send(tx, [accountId], 'governance_board.seat', term.id, {
      role,
    });
  }

  /** Ends an open term now. The board lock is held. */
  async endTerm(
    tx: TenantTxClient,
    term: BoardTerm,
    now: Date,
    reason: 'succeeded' | 'replaced',
    byTermId: string,
  ): Promise<void> {
    await tx.boardTerm.update({
      where: { id: term.id },
      data: {
        endedAt: now < term.startsAt ? term.startsAt : now,
        endReason: reason,
      },
    });
    await this.audit.record(tx, {
      action: 'board_term.ended',
      targetId: term.id,
      metadata: { reason, byTermId },
    });
  }

  /**
   * The account's seats in the open term end (the system's reasons: it owns
   * no unit any more, or it was closed). Returns how many.
   */
  async endSeatsOf(
    tx: TenantTxClient,
    accountId: string,
    reason: (typeof REASON_CODES.boardMemberSystemEnd)[number],
  ): Promise<number> {
    await this.access.lockBoard(tx);
    const now = await dbNow(tx);
    const seats = await tx.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM board_members m
        JOIN board_terms t ON t.tenant_id = m.tenant_id AND t.id = m.term_id
       WHERE m.account_id = ${accountId}::uuid AND m.ended_at IS NULL
         AND t.ended_at IS NULL
       ORDER BY m.id FOR UPDATE OF m`;
    for (const { id } of seats) {
      const member = await tx.boardMember.findUniqueOrThrow({ where: { id } });
      await this.endSeat(tx, member, now, reason, null);
    }
    return seats.length;
  }

  private async endSeat(
    tx: TenantTxClient,
    member: BoardMember,
    now: Date,
    reason: BoardMemberEndReason,
    by: string | null,
  ): Promise<void> {
    await tx.boardMember.update({
      where: { id: member.id },
      data: {
        endedAt: now < member.addedAt ? member.addedAt : now,
        endReason: reason,
        endedById: by,
      },
    });
    await this.audit.record(tx, {
      action: 'board_member.ended',
      targetId: member.id,
      metadata: {
        termId: member.termId,
        accountId: member.accountId,
        reasonCode: reason,
        side: by ? 'manager' : 'system',
      },
    });
  }

  private officeFree(seated: readonly BoardMember[], role: BoardRole): void {
    if (role !== 'member' && seated.some((m) => m.role === role))
      throw appError.conflict(
        ErrorCode.BOARD_OFFICE_TAKEN,
        'Another member holds this office',
        { params: { role } },
      );
  }
}

/** What an appointment's own fields say, before the database is read. */
export function checkAppointment(input: Appointment): FieldError[] {
  const out: FieldError[] = [];
  const { min, max } = BOARD_SEATS;
  if (input.seats < min || input.seats > max)
    out.push({
      field: 'seats',
      code: FieldErrorCode.BOARD_SIZE,
      params: { min, max },
    });
  if (input.members.length < min || input.members.length > input.seats)
    out.push({
      field: 'members',
      code: FieldErrorCode.BOARD_SIZE,
      params: { min, max: Math.min(input.seats, max) },
    });
  const ids = input.members.map((m) => m.accountId);
  const twice = ids.findIndex((id, i) => ids.indexOf(id) !== i);
  if (twice >= 0)
    out.push({
      field: `members.${twice}.accountId`,
      code: FieldErrorCode.DUPLICATE_VALUE,
    });
  const office = doubledOffice(input.members.map((m) => m.role));
  if (office)
    out.push({
      field: 'members',
      code: FieldErrorCode.DUPLICATE_VALUE,
      params: { role: office },
    });
  return out;
}
