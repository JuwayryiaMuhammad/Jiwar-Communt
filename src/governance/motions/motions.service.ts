import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BoardMotion, BoardVote } from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { GovernanceAccess } from '../access';
import { BoardService } from '../board/board.service';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import type { MatterKind, MatterKindName, MatterRow } from './matters';
import {
  closedAsItStands,
  decided,
  tally,
  type Choice,
  type Count,
  type CountResult,
  type Tally,
} from './motion-rules';
import { BoardMotionView } from './views/motions.views';

export const BOARD_MOTION_RESOURCE = 'board_motion';
export const BOARD_VOTE_RESOURCE = 'board_vote';

export type MotionStatus =
  'open' | 'carried' | 'failed' | 'withdrawn' | 'lapsed';

/** A motion as the board reads it: who proposed, every vote, the count. */
export interface MotionRecord {
  motion: BoardMotion;
  matter: MatterKindName;
  proposer: { memberId: string; fullName: string | null };
  votes: (BoardVote & { fullName: string | null })[];
  /** Live while open (the seats that count now), as stored once closed. */
  tally: Tally;
  /** How many accounts are recused from it (an appeal's). */
  recused: number;
  mine: { voted: Choice | null; recused: boolean; proposed: boolean };
}

export interface NewMotion {
  outcome: string;
  rationale: string;
  alternativesNote?: string | null;
}

const motionNotFound = () =>
  appError.notFound(ErrorCode.BOARD_MOTION_NOT_FOUND, 'Motion not found');

const seatRequired = () =>
  appError.forbidden(
    ErrorCode.BOARD_SEAT_REQUIRED,
    'Only a sitting board member does this',
  );

/** The motions of a matter. */
const ofMatterWhere = (name: MatterKindName, matterId: string) => {
  switch (name) {
    case 'approval':
      return { approvalRequestId: matterId };
    case 'appeal':
      return { boardAppealId: matterId };
    case 'representative':
      return { representativeMatterId: matterId };
  }
};

/** The matter a motion names. */
const matterOfMotion = (
  m: BoardMotion,
): { name: MatterKindName; matterId: string } => {
  if (m.approvalRequestId)
    return { name: 'approval', matterId: m.approvalRequestId };
  if (m.boardAppealId) return { name: 'appeal', matterId: m.boardAppealId };
  return { name: 'representative', matterId: m.representativeMatterId! };
};

/** The board's quorum: a majority of its seats now. */
const boardQuorum = (seats: number) => Math.floor(seats / 2) + 1;

interface Entered {
  seat: { memberId: string; termId: string };
  seats: { memberId: string; accountId: string; role: string }[];
  matter: MatterRow;
}

/**
 * The board decides by motions (ADR 0055). A sitting member proposes one
 * on a matter, with the outcome and the reasons; the members vote for or
 * against, once; the vote that decides it closes it, and a carried motion
 * decides its matter in that transaction (the matter's kind applies the
 * decision). A member closes one whose count is decided, or past the
 * matter's deadline with a quorum. A motion whose board stopped sitting
 * lapses.
 *
 * Every write locks in GovernanceAccess's order: the caller, then the
 * accounts the write may tell (the matter's people, the sitting board), the
 * caller's seat, every seat of its board (so n and the chair hold during
 * the count), the matter, the motion; then the matter's kind's own locks.
 */
@Injectable()
export class MotionsService implements OnModuleInit {
  private readonly kinds = new Map<MatterKindName, MatterKind>();

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly board: BoardService,
    private readonly community: CommunityGovernancePort,
    private readonly notices: GovernanceNotices,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  register(kind: MatterKind): void {
    if (this.kinds.has(kind.name))
      throw new Error(`Matter kind ${kind.name} is registered twice`);
    this.kinds.set(kind.name, kind);
  }

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(BOARD_MOTION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        BoardMotionView.from(
          await this.record(
            tx,
            await tx.boardMotion.findUniqueOrThrow({ where: { id } }),
          ),
        ),
      ),
    );
    this.idempotency.renderer(BOARD_VOTE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const vote = await tx.boardVote.findUniqueOrThrow({ where: { id } });
        return BoardMotionView.from(
          await this.record(
            tx,
            await tx.boardMotion.findUniqueOrThrow({
              where: { id: vote.motionId },
            }),
          ),
        );
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Writing: a sitting member
  // --------------------------------------------------------------------------

  propose(
    name: MatterKindName,
    matterId: string,
    input: NewMotion,
  ): Promise<MotionRecord> {
    const kind = this.kind(name);
    if (!kind.outcomes.includes(input.outcome))
      throw invalid([
        {
          field: 'outcome',
          code: FieldErrorCode.INVALID_VALUE,
          params: { allowed: [...kind.outcomes] },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { seat, seats, matter } = await this.enter(tx, kind, matterId);
      if (matter.status !== 'pending') throw matterDecided(matter.status);
      const now = await dbNow(tx);
      const open = await this.openMotionOf(tx, name, matterId);
      if (open && open.termId !== seat.termId)
        await this.closeMotion(tx, open, 'lapsed', null, null, now, 'system');
      else if (open)
        throw appError.conflict(
          ErrorCode.BOARD_MOTION_OPEN,
          'The matter has an open motion',
          { params: { motionId: open.id } },
        );
      // Recusal (ADR 0055): the snapshot of who may not act on it, taken
      // now; the members left must be able to make the board's quorum.
      const recused = await kind.recusals(tx, matter);
      if (recused.includes(this.ctx.accountId)) throw memberRecused();
      const eligible = seats.filter((s) => !recused.includes(s.accountId));
      if (eligible.length < boardQuorum(seats.length))
        throw quorumUnavailable(eligible.length, boardQuorum(seats.length));
      const id = newId();
      await this.idempotency.claim(tx, { type: BOARD_MOTION_RESOURCE, id });
      const motion = await tx.boardMotion.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          ...ofMatterWhere(name, matterId),
          termId: seat.termId,
          proposedByMemberId: seat.memberId,
          proposedById: this.ctx.accountId,
          outcome: input.outcome,
          rationale: input.rationale,
          alternativesNote: input.alternativesNote ?? null,
          openedAt: now,
        },
      });
      if (recused.length)
        await tx.boardMotionRecusal.createMany({
          data: recused.map((accountId) => ({
            tenantId: this.ctx.txTenantId,
            motionId: id,
            accountId,
          })),
        });
      await this.audit.record(tx, {
        action: 'board_motion.proposed',
        targetId: id,
        changes: diffChanges(
          null,
          {
            matter: name,
            matterId,
            outcome: input.outcome,
            termId: seat.termId,
            memberId: seat.memberId,
            rationale: input.rationale,
            alternativesNote: input.alternativesNote ?? null,
          },
          'board_motion.proposed',
        ),
        metadata: { recused: recused.length },
      });
      await this.notices.send(
        tx,
        eligible
          .map((s) => s.accountId)
          .filter((a) => a !== this.ctx.accountId),
        'governance_motion.proposed',
        id,
        { matter: name },
      );
      return this.record(tx, motion);
    });
  }

  vote(motionId: string, choice: Choice): Promise<MotionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { kind, matterId } = await this.matterOf(tx, motionId);
      const { seat, seats, matter } = await this.enter(tx, kind, matterId);
      const motion = await this.lockOpen(tx, motionId, seat.termId);
      const recused = await this.recusedOf(tx, motion.id);
      if (recused.includes(this.ctx.accountId)) throw memberRecused();
      const already = await tx.boardVote.findFirst({
        where: { motionId, memberId: seat.memberId },
      });
      if (already)
        throw appError.conflict(
          ErrorCode.BOARD_ALREADY_VOTED,
          'The member voted on this motion already',
        );
      const now = await dbNow(tx);
      const id = newId();
      await this.idempotency.claim(tx, { type: BOARD_VOTE_RESOURCE, id });
      await tx.boardVote.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          motionId,
          memberId: seat.memberId,
          accountId: this.ctx.accountId,
          choice,
          castAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'board_vote.cast',
        targetId: motionId,
        metadata: { memberId: seat.memberId, voteId: id },
      });
      const count = await this.countOf(tx, motion, seats);
      // Too few may act (seats ended since it opened): it cannot carry.
      const result =
        count.seats.length >= boardQuorum(seats.length) ? decided(count) : null;
      if (result)
        await this.conclude(
          tx,
          kind,
          matter,
          motion,
          result,
          count,
          now,
          'vote',
        );
      return this.record(
        tx,
        await tx.boardMotion.findUniqueOrThrow({ where: { id: motionId } }),
      );
    });
  }

  /**
   * A member closes a motion: one whose count is decided, or, past the
   * matter's deadline, as the votes stand with a quorum.
   */
  close(motionId: string): Promise<MotionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { kind, matterId } = await this.matterOf(tx, motionId);
      const { seat, seats, matter } = await this.enter(tx, kind, matterId);
      const motion = await this.lockOpen(tx, motionId, seat.termId);
      if ((await this.recusedOf(tx, motion.id)).includes(this.ctx.accountId))
        throw memberRecused();
      const now = await dbNow(tx);
      const count = await this.countOf(tx, motion, seats);
      if (count.seats.length < boardQuorum(seats.length))
        throw quorumUnavailable(count.seats.length, boardQuorum(seats.length));
      let result: CountResult | null = decided(count);
      if (!result) {
        if (now < matter.deadlineAt)
          throw appError.conflict(
            ErrorCode.BOARD_VOTE_NOT_DUE,
            'The count is not decided and the deadline has not passed',
            { params: { deadlineAt: matter.deadlineAt.toISOString() } },
          );
        result = closedAsItStands(count);
        if (!result) {
          const t = tally(count);
          throw appError.conflict(
            ErrorCode.BOARD_QUORUM_NOT_MET,
            'Too few votes for a quorum',
            { params: { cast: t.cast, quorum: t.quorum } },
          );
        }
      }
      await this.conclude(
        tx,
        kind,
        matter,
        motion,
        result,
        count,
        now,
        'close',
      );
      return this.record(
        tx,
        await tx.boardMotion.findUniqueOrThrow({ where: { id: motionId } }),
      );
    });
  }

  /** Its proposer withdraws an open motion; the matter waits for another. */
  withdraw(motionId: string): Promise<MotionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { kind, matterId } = await this.matterOf(tx, motionId);
      const { seat } = await this.enter(tx, kind, matterId);
      const motion = await this.lockOpen(tx, motionId, seat.termId);
      if (motion.proposedById !== this.ctx.accountId)
        throw appError.forbidden(
          ErrorCode.BOARD_MOTION_NOT_YOURS,
          'Only its proposer withdraws a motion',
        );
      const now = await dbNow(tx);
      await this.closeMotion(
        tx,
        motion,
        'withdrawn',
        null,
        this.ctx.accountId,
        now,
        'proposer',
      );
      return this.record(
        tx,
        await tx.boardMotion.findUniqueOrThrow({ where: { id: motionId } }),
      );
    });
  }

  // --------------------------------------------------------------------------
  // For the matters' services, in their transactions
  // --------------------------------------------------------------------------

  /**
   * The matter was withdrawn (its row locked for update): its open motion,
   * if any, closes as withdrawn by `by`. Returns its id.
   */
  async closeWithMatter(
    tx: TenantTxClient,
    name: MatterKindName,
    matterId: string,
    by: string,
    now: Date,
  ): Promise<string | null> {
    const open = await this.openMotionOf(tx, name, matterId);
    if (!open) return null;
    await this.closeMotion(tx, open, 'withdrawn', null, by, now, 'matter');
    return open.id;
  }

  /** Every motion on a matter, oldest first, for the board's views. */
  async ofMatter(
    tx: TenantTxClient,
    name: MatterKindName,
    matterId: string,
  ): Promise<MotionRecord[]> {
    const rows = await tx.boardMotion.findMany({
      where: ofMatterWhere(name, matterId),
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    });
    const out: MotionRecord[] = [];
    for (const m of rows) out.push(await this.record(tx, m));
    return out;
  }

  /**
   * The sweep: open motions whose board no longer sits lapse, one per
   * transaction (the matter, then the motion, SKIP LOCKED: a vote in flight
   * holds them, and the next run takes it).
   */
  async lapseOne(
    tx: TenantTxClient,
    motionId: string,
    now: Date,
  ): Promise<number> {
    const seen = await tx.boardMotion.findUnique({ where: { id: motionId } });
    if (!seen || seen.closedAt) return 0;
    const { name, matterId } = matterOfMotion(seen);
    const locked = await this.kind(name).lockSkip(tx, matterId);
    if (!locked) return 0;
    const [m] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM board_motions WHERE id = ${motionId}::uuid
       FOR UPDATE SKIP LOCKED`;
    if (!m) return 0;
    const motion = await tx.boardMotion.findUniqueOrThrow({
      where: { id: motionId },
    });
    if (motion.closedAt) return 0;
    if (await this.sits(tx, motion.termId, now)) return 0;
    await this.closeMotion(tx, motion, 'lapsed', null, null, now, 'system');
    return 1;
  }

  // --------------------------------------------------------------------------

  private kind(name: MatterKindName): MatterKind {
    const kind = this.kinds.get(name);
    if (!kind) throw new Error(`No matter kind ${name}`);
    return kind;
  }

  /** Steps 1–5 of the lock order, for a sitting member acting on a matter. */
  private async enter(
    tx: TenantTxClient,
    kind: MatterKind,
    matterId: string,
  ): Promise<Entered> {
    await this.access.lockSelf(tx);
    const hint = await dbNow(tx);
    await this.access.lockAccounts(tx, [
      ...(await kind.told(tx, matterId)),
      ...(await this.board.seatedAccounts(tx, hint)),
    ]);
    const seat = await this.access.lockSeat(tx, this.ctx.accountId);
    if (!seat) throw seatRequired();
    const seats = await this.access.lockBoardForVote(tx, seat.termId);
    const matter = await kind.lock(tx, matterId);
    return { seat, seats, matter };
  }

  private async matterOf(
    tx: TenantTxClient,
    motionId: string,
  ): Promise<{ kind: MatterKind; matterId: string }> {
    const motion = await tx.boardMotion.findUnique({ where: { id: motionId } });
    if (!motion) throw motionNotFound();
    const { name, matterId } = matterOfMotion(motion);
    return { kind: this.kind(name), matterId };
  }

  /** The motion for update, open and of the board sitting now. */
  private async lockOpen(
    tx: TenantTxClient,
    motionId: string,
    termId: string,
  ): Promise<BoardMotion> {
    await tx.$queryRaw`
      SELECT id FROM board_motions WHERE id = ${motionId}::uuid FOR UPDATE`;
    const motion = await tx.boardMotion.findUniqueOrThrow({
      where: { id: motionId },
    });
    if (motion.closedAt)
      throw appError.conflict(
        ErrorCode.BOARD_MOTION_CLOSED,
        'The motion closed already',
        { params: motion.result ? { result: motion.result } : {} },
      );
    if (motion.termId !== termId)
      throw appError.conflict(
        ErrorCode.BOARD_MOTION_LAPSED,
        'The board this motion was put to no longer sits',
      );
    return motion;
  }

  private openMotionOf(
    tx: TenantTxClient,
    name: MatterKindName,
    matterId: string,
  ): Promise<BoardMotion | null> {
    return tx.boardMotion.findFirst({
      where: { ...ofMatterWhere(name, matterId), closedAt: null },
    });
  }

  /** The count now: the seats locked, less the motion's recused. */
  private async countOf(
    tx: TenantTxClient,
    motion: BoardMotion,
    seats: Entered['seats'],
  ): Promise<Count> {
    const recused = new Set(await this.recusedOf(tx, motion.id));
    const counting = seats.filter((s) => !recused.has(s.accountId));
    const votes = await tx.boardVote.findMany({
      where: { motionId: motion.id },
    });
    return {
      seats: counting.map((s) => s.memberId),
      chair: seats.find((s) => s.role === 'chair')?.memberId ?? null,
      votes: new Map(votes.map((v) => [v.memberId, v.choice as Choice])),
    };
  }

  /** Closes the motion with its count, and a carried one decides its matter. */
  private async conclude(
    tx: TenantTxClient,
    kind: MatterKind,
    matter: MatterRow,
    motion: BoardMotion,
    result: CountResult,
    count: Count,
    now: Date,
    by: 'vote' | 'close',
  ): Promise<void> {
    await this.closeMotion(
      tx,
      motion,
      result,
      tally(count),
      this.ctx.accountId,
      now,
      by,
      count.chair,
    );
    if (result === 'carried')
      await kind.decide(tx, {
        matter,
        motion: await tx.boardMotion.findUniqueOrThrow({
          where: { id: motion.id },
        }),
        now,
      });
  }

  private async closeMotion(
    tx: TenantTxClient,
    motion: BoardMotion,
    result: MotionStatus,
    t: Tally | null,
    by: string | null,
    now: Date,
    side: 'vote' | 'close' | 'proposer' | 'matter' | 'system',
    chair: string | null = null,
  ): Promise<void> {
    await tx.boardMotion.update({
      where: { id: motion.id },
      data: {
        closedAt: now,
        result,
        closedById: by,
        votesFor: t?.for ?? null,
        votesAgainst: t?.against ?? null,
        sitting: t?.n ?? null,
      },
    });
    await this.audit.record(tx, {
      action: 'board_motion.closed',
      targetId: motion.id,
      metadata: {
        result,
        votesFor: t?.for ?? null,
        votesAgainst: t?.against ?? null,
        sitting: t?.n ?? null,
        quorum: t?.quorum ?? null,
        // The chair's seat the count saw (a tie is its vote), or null.
        chair: t ? chair : null,
        by: side,
      },
    });
  }

  /** Open motions whose board does not sit at `now`: the sweep's list. */
  async lapsedDue(tx: TenantTxClient, now: Date): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM board_motions m
        JOIN board_terms t ON t.tenant_id = m.tenant_id AND t.id = m.term_id
       WHERE m.closed_at IS NULL
         AND (t.ended_at IS NOT NULL OR t.ends_at <= ${now} OR t.starts_at > ${now})
       ORDER BY m.opened_at, m.id LIMIT 50`;
    return rows.map((r) => r.id);
  }

  /** Whether the term sits now (not ended, inside its dates). */
  private async sits(
    tx: TenantTxClient,
    termId: string,
    now: Date,
  ): Promise<boolean> {
    const term = await tx.boardTerm.findUnique({ where: { id: termId } });
    return Boolean(
      term && !term.endedAt && term.startsAt <= now && term.endsAt > now,
    );
  }

  /** The accounts recused from a motion (none on a request's). */
  private async recusedOf(
    tx: TenantTxClient,
    motionId: string,
  ): Promise<string[]> {
    return (
      await tx.boardMotionRecusal.findMany({
        where: { motionId },
        select: { accountId: true },
      })
    ).map((r) => r.accountId);
  }

  /** A motion as the board reads it. */
  async record(tx: TenantTxClient, motion: BoardMotion): Promise<MotionRecord> {
    const { name } = matterOfMotion(motion);
    const votes = await tx.boardVote.findMany({
      where: { motionId: motion.id },
      orderBy: [{ castAt: 'asc' }, { id: 'asc' }],
    });
    const names = await this.community.names(tx, [
      motion.proposedById,
      ...votes.map((v) => v.accountId),
    ]);
    const recused = await this.recusedOf(tx, motion.id);
    let t: Tally;
    if (motion.closedAt && motion.sitting !== null)
      t = {
        n: motion.sitting,
        quorum: Math.floor(motion.sitting / 2) + 1,
        cast: (motion.votesFor ?? 0) + (motion.votesAgainst ?? 0),
        for: motion.votesFor ?? 0,
        against: motion.votesAgainst ?? 0,
      };
    else {
      // A plain read: what the seats are now, for the view only.
      const seats = await tx.boardMember.findMany({
        where: { termId: motion.termId, endedAt: null },
        select: { id: true, accountId: true, role: true },
      });
      t = tally(
        await this.countOf(
          tx,
          motion,
          seats.map((s) => ({
            memberId: s.id,
            accountId: s.accountId,
            role: s.role,
          })),
        ),
      );
    }
    const mine = votes.find((v) => v.accountId === this.ctx.accountId);
    return {
      motion,
      matter: name,
      proposer: {
        memberId: motion.proposedByMemberId,
        fullName: names.get(motion.proposedById) ?? null,
      },
      votes: votes.map((v) => ({
        ...v,
        fullName: names.get(v.accountId) ?? null,
      })),
      tally: t,
      recused: recused.length,
      mine: {
        voted: (mine?.choice as Choice | undefined) ?? null,
        recused: recused.includes(this.ctx.accountId),
        proposed: motion.proposedById === this.ctx.accountId,
      },
    };
  }
}

const memberRecused = () =>
  appError.forbidden(
    ErrorCode.BOARD_MEMBER_RECUSED,
    'The member is recused from this matter: they live in or own its unit, appealed, or are whom it names',
  );

const quorumUnavailable = (eligible: number, quorum: number) =>
  appError.conflict(
    ErrorCode.BOARD_QUORUM_UNAVAILABLE,
    'Too few members may act on this matter for the board’s quorum',
    { params: { eligible, quorum } },
  );

const matterDecided = (status: string) =>
  appError.conflict(
    ErrorCode.BOARD_MATTER_DECIDED,
    'The matter was decided or withdrawn already',
    { params: { status } },
  );
