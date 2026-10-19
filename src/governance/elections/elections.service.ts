import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  GovernanceCandidate,
  GovernanceContest,
  GovernanceElection,
} from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
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
import { invalid, localized } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { GovernanceAccess } from '../access';
import { BoardService } from '../board/board.service';
import { ContestSweeps } from '../contests/contest-sweeps';
import {
  contestNotOpen,
  Contests,
  type MyUnit,
} from '../contests/contests.service';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import { POLL_LIMITS } from '../polls/poll-rules';
import {
  ELECTION_LIMITS,
  electionOutcomes,
  electionPhase,
  electionWindowProblems,
  type ElectionPhase,
  type ElectionWindow,
} from './election-rules';

export const GOVERNANCE_ELECTION_RESOURCE = 'governance_election';
export const GOVERNANCE_ELECTION_VOTE_RESOURCE = 'governance_election_vote';
export const GOVERNANCE_CANDIDACY_RESOURCE = 'governance_candidacy';
export const NOMINATIONS_SWEEP = 'governance.nominations';
const BATCH = 50;

const TEXTS = [
  { name: 'title', max: POLL_LIMITS.title },
  { name: 'body', max: POLL_LIMITS.body },
] as const;
const PAGE = keysetCursor('createdAt', 'desc');

interface ElectionFields {
  titleEn?: string | null;
  titleAr?: string | null;
  bodyEn?: string | null;
  bodyAr?: string | null;
  termMonths?: number;
  nominationsOpenAt?: Date;
  nominationsCloseAt?: Date;
  votingOpensAt?: Date;
  votingClosesAt?: Date;
}

export interface NewElection extends ElectionFields {
  seats: number;
  termMonths: number;
  nominationsCloseAt: Date;
  votingOpensAt: Date;
  votingClosesAt: Date;
}

export interface CandidateRecord extends GovernanceCandidate {
  fullName: string | null;
}

export interface ElectionRecord {
  election: GovernanceElection;
  contest: GovernanceContest;
  phase: ElectionPhase;
  candidates: CandidateRecord[];
  turnout: number | null;
  /** The reader's units in it; null for the staff. */
  myUnits: MyUnit[] | null;
  /** The reader's live or latest candidacy; null for the staff or none. */
  myCandidacy: CandidateRecord | null;
  /** The board term it seated, once certified. */
  termId: string | null;
}

export const electionNotFound = () =>
  appError.notFound(
    ErrorCode.GOVERNANCE_ELECTION_NOT_FOUND,
    'Election not found',
  );

/**
 * Elections of the board (ADR 0051). The board (or the manager) calls one:
 * its seats, the term the winners will serve, a nomination window and a
 * voting window. Owners stand with a short statement and may withdraw while
 * nominations are open; the manager may take a candidate off the list until
 * voting opens, with a reason. Voting is a secret contest in which each unit
 * picks up to `seats` candidates; with nobody standing when it opens, the
 * election is cancelled. At its close each candidate's count and outcome
 * are written once; the manager then certifies it, which seats the board
 * (certification.service.ts).
 */
@Injectable()
export class GovernanceElectionsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly community: CommunityGovernancePort,
    private readonly contests: Contests,
    private readonly sweeps: ContestSweeps,
    private readonly sweep: SweepRunner,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notices: GovernanceNotices,
    private readonly board: BoardService,
    private readonly staff: StaffRecipients,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(GOVERNANCE_ELECTION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const e = await tx.governanceElection.findUniqueOrThrow({
          where: { id },
        });
        return { id: e.id, number: e.number };
      }),
    );
    this.idempotency.renderer(GOVERNANCE_CANDIDACY_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const c = await tx.governanceCandidate.findUniqueOrThrow({
          where: { id },
        });
        return { id: c.id, electionId: c.electionId, status: c.status };
      }),
    );
    // A vote's replay says the unit voted, and nothing of the choice.
    this.idempotency.renderer(GOVERNANCE_ELECTION_VOTE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const e = await tx.governanceElection.findFirstOrThrow({
          where: { contestId: id },
        });
        const mine = await tx.governanceParticipation.findFirst({
          where: { contestId: id, voterAccountId: this.ctx.accountId },
          select: { unitId: true, votedAt: true },
          orderBy: { votedAt: 'desc' },
        });
        return {
          electionId: e.id,
          unitId: mine?.unitId ?? null,
          votedAt: mine?.votedAt ?? null,
        };
      }),
    );
    this.sweeps.register('election', {
      open: (tx, contest, now) => this.openContest(tx, contest, now),
      close: (tx, contest) => this.closeContest(tx, contest),
      remind: async (tx, contest, accounts) => {
        const e = await this.electionOf(tx, contest);
        await this.notices.send(
          tx,
          accounts,
          'governance_election.closing_soon',
          e.id,
        );
      },
    });
    this.sweep.register(NOMINATIONS_SWEEP, (now) => this.nominationsDue(now), {
      intervalMs: 60_000,
    });
  }

  // --------------------------------------------------------------------------
  // Writing: the board or the manager
  // --------------------------------------------------------------------------

  create(input: NewElection): Promise<ElectionRecord> {
    const texts = localized(input, TEXTS);
    const fields = sizeProblems(input);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // Nominations opening at once tell every owner: their accounts
      // before the seat (by a clock read only for this).
      const hint = await dbNow(tx);
      if (windowOf(input, hint).nominationsOpenAt <= hint)
        await this.access.lockOwners(tx);
      const author = await this.access.requireAuthor(tx);
      await this.contests.requireRoom(tx);
      const now = await dbNow(tx);
      const window = windowOf(input, now);
      const problems = electionWindowProblems(window, now);
      if (problems.length) throw invalid(problems as FieldError[]);
      const id = newId();
      await this.idempotency.claim(tx, {
        type: GOVERNANCE_ELECTION_RESOURCE,
        id,
      });
      const contest = await this.contests.create(tx, {
        kind: 'election',
        secret: true,
        maxChoices: input.seats,
        opensAt: window.votingOpensAt,
        closesAt: window.votingClosesAt,
        now,
      });
      const election = await tx.governanceElection.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          contestId: contest.id,
          number: await this.nextNumber(tx),
          ...texts,
          seats: input.seats,
          termMonths: input.termMonths,
          nominationsOpenAt: window.nominationsOpenAt,
          nominationsCloseAt: window.nominationsCloseAt,
          authorSide: author.side,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_election.created',
        targetId: id,
        changes: diffChanges(
          null,
          audited(election, contest),
          'governance_election.created',
        ),
        metadata: { side: author.side },
      });
      if (window.nominationsOpenAt <= now)
        await this.tellNominations(tx, election, now);
      return this.load(tx, election, null);
    });
  }

  /** Before nominations open, its texts, term and dates change; never its seats. */
  update(id: string, input: ElectionFields): Promise<ElectionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.governanceElection.findUnique({
        where: { id },
        select: { nominationsOpenAt: true },
      });
      const hint = await dbNow(tx);
      if (seen && (input.nominationsOpenAt ?? seen.nominationsOpenAt) <= hint)
        await this.access.lockOwners(tx);
      await this.access.requireAuthor(tx);
      const { election, contest } = await this.lockElection(tx, id, 'update');
      const now = await dbNow(tx);
      const phase = electionPhase(election, contest, now);
      if (phase !== 'upcoming' || election.nominationsNotifiedAt)
        throw appError.conflict(
          ErrorCode.GOVERNANCE_CONTEST_STARTED,
          'Nominations have opened: only a cancel now',
          { params: { status: phase } },
        );
      const texts = localized(input, TEXTS, {
        titleEn: election.titleEn,
        titleAr: election.titleAr,
        bodyEn: election.bodyEn,
        bodyAr: election.bodyAr,
      });
      const termMonths = input.termMonths ?? election.termMonths;
      const fields = sizeProblems({ seats: election.seats, termMonths });
      if (fields.length) throw invalid(fields);
      const window = windowOf(
        {
          nominationsOpenAt:
            input.nominationsOpenAt ?? election.nominationsOpenAt,
          nominationsCloseAt:
            input.nominationsCloseAt ?? election.nominationsCloseAt,
          votingOpensAt: input.votingOpensAt ?? contest.opensAt,
          votingClosesAt: input.votingClosesAt ?? contest.closesAt,
        },
        now,
      );
      const problems = electionWindowProblems(window, now);
      if (problems.length) throw invalid(problems as FieldError[]);
      const before = audited(election, contest);
      const updatedContest = await tx.governanceContest.update({
        where: { id: contest.id },
        data: {
          opensAt: window.votingOpensAt,
          closesAt: window.votingClosesAt,
        },
      });
      const updated = await tx.governanceElection.update({
        where: { id },
        data: {
          ...texts,
          termMonths,
          nominationsOpenAt: window.nominationsOpenAt,
          nominationsCloseAt: window.nominationsCloseAt,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_election.changed',
        targetId: id,
        changes: diffChanges(
          before,
          audited(updated, updatedContest),
          'governance_election.changed',
        ),
      });
      if (window.nominationsOpenAt <= now)
        await this.tellNominations(tx, updated, now);
      return this.load(tx, updated, null);
    });
  }

  /** Ends an election before its certification, with a reason's code. */
  cancel(id: string, reasonCode: string | undefined): Promise<ElectionRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.governanceElectionCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const author = await this.access.requireAuthor(tx);
      const { election, contest } = await this.lockElection(tx, id, 'update');
      const now = await dbNow(tx);
      const phase = electionPhase(election, contest, now);
      if (phase === 'certified' || phase === 'cancelled')
        throw appError.conflict(
          ErrorCode.GOVERNANCE_CONTEST_ENDED,
          'The election ended already',
          { params: { status: phase } },
        );
      const updated = await this.end(tx, election, contest, now, {
        reason,
        by: this.ctx.accountId,
        side: author.side,
        phase,
      });
      return this.load(tx, updated, null);
    });
  }

  // --------------------------------------------------------------------------
  // Standing: an owner
  // --------------------------------------------------------------------------

  /** The caller stands, with a short statement, while nominations are open. */
  nominate(id: string, statement: string | undefined): Promise<ElectionRecord> {
    const words = statement?.trim().replace(/[ \t]+/g, ' ') || null;
    if (words && words.length > ELECTION_LIMITS.statement)
      throw invalid([
        {
          field: 'statement',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: ELECTION_LIMITS.statement },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const me = this.ctx.accountId;
      if (!(await this.community.isOwner(tx, me)))
        throw appError.forbidden(
          ErrorCode.GOVERNANCE_CANDIDACY_NOT_ALLOWED,
          'Only an owner of a unit stands',
        );
      const { election, contest } = await this.lockElection(tx, id, 'share');
      const now = await dbNow(tx);
      const phase = electionPhase(election, contest, now);
      if (phase !== 'nominating') throw nominationsClosed(phase);
      const live = await tx.governanceCandidate.findMany({
        where: { electionId: id, status: 'nominated' },
        select: { accountId: true },
      });
      if (live.some((c) => c.accountId === me))
        throw appError.conflict(
          ErrorCode.GOVERNANCE_ALREADY_CANDIDATE,
          'The caller stands already',
        );
      if (live.length >= ELECTION_LIMITS.candidates)
        throw appError.conflict(
          ErrorCode.GOVERNANCE_LIMIT_REACHED,
          'The election has as many candidates as it takes',
          { params: { max: ELECTION_LIMITS.candidates } },
        );
      const candidateId = newId();
      await this.idempotency.claim(tx, {
        type: GOVERNANCE_CANDIDACY_RESOURCE,
        id: candidateId,
      });
      await tx.governanceCandidate.create({
        data: {
          id: candidateId,
          tenantId: this.ctx.txTenantId,
          electionId: id,
          accountId: me,
          statement: words,
          nominatedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_candidate.nominated',
        targetId: candidateId,
        metadata: { electionId: id, statement: words !== null },
      });
      return this.load(tx, election, me);
    });
  }

  /** The caller withdraws, while nominations are open. */
  withdraw(id: string): Promise<ElectionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const me = this.ctx.accountId;
      const { election, contest } = await this.lockElection(tx, id, 'share');
      const now = await dbNow(tx);
      const phase = electionPhase(election, contest, now);
      if (phase !== 'nominating') throw nominationsClosed(phase);
      const mine = await tx.governanceCandidate.findFirst({
        where: { electionId: id, accountId: me, status: 'nominated' },
      });
      if (!mine)
        throw appError.notFound(
          ErrorCode.GOVERNANCE_CANDIDATE_NOT_FOUND,
          'The caller does not stand',
        );
      await this.endCandidacy(tx, mine, now, 'withdrawn', null, null);
      return this.load(tx, election, me);
    });
  }

  /** The manager takes a candidate off the list, before voting opens. */
  disqualify(
    id: string,
    candidateId: string,
    reasonCode: string | undefined,
  ): Promise<ElectionRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.governanceCandidateDisqualify,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const { election, contest } = await this.lockElection(tx, id, 'share');
      const now = await dbNow(tx);
      const phase = electionPhase(election, contest, now);
      if (phase !== 'nominating' && phase !== 'nominations_closed')
        throw appError.conflict(
          ErrorCode.GOVERNANCE_CONTEST_STARTED,
          'The list is fixed once voting opened',
          { params: { status: phase } },
        );
      const candidate = await tx.governanceCandidate.findFirst({
        where: { id: candidateId, electionId: id, status: 'nominated' },
      });
      if (!candidate)
        throw appError.notFound(
          ErrorCode.GOVERNANCE_CANDIDATE_NOT_FOUND,
          'Candidate not found',
        );
      await this.endCandidacy(
        tx,
        candidate,
        now,
        'disqualified',
        reason,
        this.ctx.accountId,
      );
      return this.load(tx, election, null);
    });
  }

  /**
   * The account's live candidacies in elections whose nominations are open
   * or closed but not voted on yet end (the system's reasons); one on a
   * list voting has opened on stays, and is checked at the certification.
   */
  async withdrawAllOf(
    tx: TenantTxClient,
    accountId: string,
    reason: (typeof REASON_CODES.governanceCandidateSystemWithdraw)[number],
  ): Promise<number> {
    const now = await dbNow(tx);
    const live = await tx.governanceCandidate.findMany({
      where: { accountId, status: 'nominated' },
      orderBy: { id: 'asc' },
    });
    let done = 0;
    for (const c of live) {
      const election = await tx.governanceElection.findUniqueOrThrow({
        where: { id: c.electionId },
      });
      const contest = await this.contests.lock(tx, election.contestId, 'share');
      if (!contest || contest.openedAt || contest.cancelledAt) continue;
      await this.endCandidacy(tx, c, now, 'withdrawn', reason, null);
      done += 1;
    }
    return done;
  }

  // --------------------------------------------------------------------------
  // Voting: a unit's voting owner
  // --------------------------------------------------------------------------

  vote(
    id: string,
    input: { unitId: string; candidateIds: string[] },
  ): Promise<{ electionId: string; unitId: string; votedAt: Date }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const { election, contest } = await this.lockElection(tx, id, 'share');
      const now = await dbNow(tx);
      const status = this.contests.status(contest, now);
      if (status !== 'open') throw contestNotOpen(status);
      const choice = [...new Set(input.candidateIds)];
      // Codes only: never the ids sent back, not even in an error.
      if (
        choice.length !== input.candidateIds.length ||
        choice.length < 1 ||
        choice.length > election.seats
      )
        throw invalid([
          {
            field: 'candidateIds',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { min: 1, max: election.seats },
          },
        ]);
      const standing = new Set(
        (
          await tx.governanceCandidate.findMany({
            where: { electionId: id, status: 'nominated' },
            select: { id: true },
          })
        ).map((c) => c.id),
      );
      if (choice.some((c) => !standing.has(c)))
        throw invalid([
          { field: 'candidateIds', code: FieldErrorCode.INVALID_VALUE },
        ]);
      await this.idempotency.claim(tx, {
        type: GOVERNANCE_ELECTION_VOTE_RESOURCE,
        id: contest.id,
      });
      const votedAt = await this.contests.cast(
        tx,
        contest,
        input.unitId,
        choice.sort(),
        now,
      );
      return { electionId: id, unitId: input.unitId, votedAt };
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  ownersList(q: {
    phase?: ElectionPhase;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ElectionRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.requireOwner(tx);
      return this.page(tx, q, this.ctx.accountId);
    });
  }

  /** An owner's, or an elector's who no longer owns the unit they vote for. */
  ownersGet(id: string): Promise<ElectionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const election = await tx.governanceElection.findUnique({
        where: { id },
      });
      const me = this.ctx.accountId;
      const elector =
        election &&
        (await tx.governanceElector.count({
          where: { contestId: election.contestId, accountId: me },
        }));
      if (!elector) await this.access.requireOwner(tx);
      if (!election) throw electionNotFound();
      return this.load(tx, election, me);
    });
  }

  staffList(q: {
    phase?: ElectionPhase;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ElectionRecord>> {
    return this.tenantTx.withTenantTx((tx) => this.page(tx, q, null));
  }

  staffGet(id: string): Promise<ElectionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const election = await tx.governanceElection.findUnique({
        where: { id },
      });
      if (!election) throw electionNotFound();
      return this.load(tx, election, null);
    });
  }

  // --------------------------------------------------------------------------
  // The contest's time, and the nominations' opening
  // --------------------------------------------------------------------------

  /**
   * Voting opens: the list is fixed; with nobody on it the election is
   * cancelled (`no_candidates`) and the board told; otherwise the
   * electorate is taken and told.
   */
  async openContest(
    tx: TenantTxClient,
    contest: GovernanceContest,
    now: Date,
  ): Promise<void> {
    const election = await this.electionOf(tx, contest);
    const candidates = await tx.governanceCandidate.count({
      where: { electionId: election.id, status: 'nominated' },
    });
    if (!candidates) {
      await this.end(tx, election, contest, now, {
        reason: 'no_candidates',
        by: null,
        side: 'system',
        phase: 'nominations_closed',
      });
      return;
    }
    const electors = await this.contests.open(tx, contest, now);
    await this.audit.record(tx, {
      action: 'governance_election.opened',
      targetId: election.id,
      metadata: { electorate: electors.length, candidates },
    });
    await this.notices.send(
      tx,
      electors,
      'governance_election.opened',
      election.id,
    );
  }

  /** Voting closed: each candidate's count and outcome, once; the certifiers told. */
  async closeContest(
    tx: TenantTxClient,
    contest: GovernanceContest,
  ): Promise<void> {
    const election = await this.electionOf(tx, contest);
    const { turnout, counts } = await this.contests.close(tx, contest);
    const candidates = await tx.governanceCandidate.findMany({
      where: { electionId: election.id, status: 'nominated' },
      orderBy: { id: 'asc' },
    });
    const { outcomes, tied, remaining } = electionOutcomes(
      candidates.map((c) => ({ id: c.id, votes: counts.get(c.id) ?? 0 })),
      election.seats,
    );
    for (const c of candidates)
      await tx.governanceCandidate.update({
        where: { id: c.id },
        data: {
          finalCount: counts.get(c.id) ?? 0,
          outcome: outcomes.get(c.id) ?? 'not_elected',
        },
      });
    const elected = [...outcomes.values()].filter(
      (o) => o === 'elected',
    ).length;
    await this.audit.record(tx, {
      action: 'governance_election.closed',
      targetId: election.id,
      metadata: {
        turnout,
        electorate: contest.electorate ?? 0,
        elected,
        tied: tied.length,
        remaining,
      },
    });
    const now = await dbNow(tx);
    await this.notices.send(
      tx,
      [
        ...(await this.staff.holding(tx, 'governance.manage')).map((s) => s.id),
        ...(await this.board.seatedAccounts(tx, now)),
      ],
      'governance_election.awaiting_certification',
      election.id,
      { tied: tied.length ? 'yes' : 'no' },
    );
  }

  /** Tells the owners nominations opened, once, as they open. */
  nominationsDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.governanceElection.findMany({
            where: {
              nominationsNotifiedAt: null,
              cancelReasonCode: null,
              nominationsOpenAt: { lte: now },
              nominationsCloseAt: { gt: now },
            },
            orderBy: [{ nominationsOpenAt: 'asc' }, { id: 'asc' }],
            take: BATCH,
            select: { id: true },
          })
        ).map((e) => e.id),
      async (tx, _tenantId, id) => {
        const election = await tx.governanceElection.findUniqueOrThrow({
          where: { id },
        });
        return (await this.tellNominations(tx, election, now)) ? 1 : 0;
      },
    );
  }

  // --------------------------------------------------------------------------

  /** "Once" is nominations_notified_at, claimed with a conditional update. */
  private async tellNominations(
    tx: TenantTxClient,
    election: GovernanceElection,
    now: Date,
  ): Promise<boolean> {
    const { count } = await tx.governanceElection.updateMany({
      where: {
        id: election.id,
        nominationsNotifiedAt: null,
        cancelReasonCode: null,
      },
      data: { nominationsNotifiedAt: now },
    });
    if (!count) return false;
    await this.notices.send(
      tx,
      await this.community.owners(tx),
      'governance_election.nominations_opened',
      election.id,
    );
    return true;
  }

  private async end(
    tx: TenantTxClient,
    election: GovernanceElection,
    contest: GovernanceContest,
    now: Date,
    how: {
      reason: string;
      by: string | null;
      side: 'manager' | 'board' | 'system';
      phase: ElectionPhase;
    },
  ): Promise<GovernanceElection> {
    // Voting closed but not certified: the count stands, the election ends.
    if (!contest.cancelledAt && !contest.closedAt)
      await this.contests.cancel(tx, contest, now);
    const updated = await tx.governanceElection.update({
      where: { id: election.id },
      data: { cancelReasonCode: how.reason, cancelledById: how.by },
    });
    await this.audit.record(tx, {
      action: 'governance_election.cancelled',
      targetId: election.id,
      metadata: {
        fromPhase: how.phase,
        reasonCode: how.reason,
        side: how.side,
      },
    });
    await this.notices.send(
      tx,
      await this.board.seatedAccounts(tx, now),
      'governance_election.cancelled',
      election.id,
      { reason: how.reason },
    );
    return updated;
  }

  private async endCandidacy(
    tx: TenantTxClient,
    c: GovernanceCandidate,
    now: Date,
    status: 'withdrawn' | 'disqualified',
    reason: string | null,
    by: string | null,
  ): Promise<void> {
    await tx.governanceCandidate.update({
      where: { id: c.id },
      data: { status, endedAt: now, reasonCode: reason, endedById: by },
    });
    if (status === 'disqualified')
      await this.audit.record(tx, {
        action: 'governance_candidate.disqualified',
        targetId: c.id,
        metadata: { electionId: c.electionId, reasonCode: reason },
      });
    else
      await this.audit.record(tx, {
        action: 'governance_candidate.withdrawn',
        targetId: c.id,
        metadata: {
          electionId: c.electionId,
          side: reason ? 'system' : 'candidate',
          reasonCode: reason,
        },
      });
  }

  private async page(
    tx: TenantTxClient,
    q: { phase?: ElectionPhase; cursor?: string; limit?: number },
    reader: string | null,
  ): Promise<Page<ElectionRecord>> {
    const limit = clampLimit(q.limit);
    const items: ElectionRecord[] = [];
    let cursor = q.cursor;
    // Phases are judged on the clock: filter after the read, page by page.
    for (;;) {
      const rows = await tx.governanceElection.findMany({
        where: { AND: PAGE.after(cursor) },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      for (const e of page.items) {
        const r = await this.load(tx, e, reader);
        if (!q.phase || r.phase === q.phase) items.push(r);
        if (items.length === limit)
          return { items, nextCursor: PAGE.encode(e) };
      }
      if (!page.nextCursor) return { items, nextCursor: null };
      cursor = page.nextCursor;
    }
  }

  async load(
    tx: TenantTxClient,
    election: GovernanceElection,
    reader: string | null,
  ): Promise<ElectionRecord> {
    const contest = await tx.governanceContest.findUniqueOrThrow({
      where: { id: election.contestId },
    });
    const now = await dbNow(tx);
    const rows = await tx.governanceCandidate.findMany({
      where: { electionId: election.id },
      orderBy: [{ nominatedAt: 'asc' }, { id: 'asc' }],
    });
    const names = await this.community.names(
      tx,
      rows.map((c) => c.accountId),
    );
    const candidates = rows.map((c) => ({
      ...c,
      fullName: names.get(c.accountId) ?? null,
    }));
    const term = election.certifiedAt
      ? await tx.boardTerm.findFirst({
          where: { electionId: election.id },
          select: { id: true },
        })
      : null;
    return {
      election,
      contest,
      phase: electionPhase(election, contest, now),
      candidates,
      turnout: contest.openedAt
        ? (contest.turnout ?? (await this.contests.turnout(tx, contest.id)))
        : null,
      myUnits: reader
        ? await this.contests.myUnits(tx, contest.id, reader)
        : null,
      myCandidacy: reader
        ? ([...candidates].reverse().find((c) => c.accountId === reader) ??
          null)
        : null,
      termId: term?.id ?? null,
    };
  }

  async lockElection(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<{ election: GovernanceElection; contest: GovernanceContest }> {
    const election = await tx.governanceElection.findUnique({ where: { id } });
    if (!election) throw electionNotFound();
    const contest = await this.contests.lock(tx, election.contestId, mode);
    if (!contest) throw electionNotFound();
    return {
      election: await tx.governanceElection.findUniqueOrThrow({
        where: { id },
      }),
      contest,
    };
  }

  private electionOf(tx: TenantTxClient, contest: GovernanceContest) {
    return tx.governanceElection.findFirstOrThrow({
      where: { contestId: contest.id },
    });
  }

  private async nextNumber(tx: TenantTxClient): Promise<number> {
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO governance_counters (tenant_id, kind, last_number)
      VALUES (${this.ctx.txTenantId}::uuid, 'election'::governance_contest_kind, 1)
      ON CONFLICT (tenant_id, kind)
        DO UPDATE SET last_number = governance_counters.last_number + 1
      RETURNING last_number AS number`;
    return number;
  }
}

const nominationsClosed = (phase: ElectionPhase) =>
  appError.conflict(
    ErrorCode.GOVERNANCE_NOMINATIONS_CLOSED,
    'Nominations are not open',
    { params: { phase } },
  );

function windowOf(
  input: Partial<ElectionWindow> &
    Pick<
      ElectionWindow,
      'nominationsCloseAt' | 'votingOpensAt' | 'votingClosesAt'
    >,
  now: Date,
): ElectionWindow {
  const opens =
    input.nominationsOpenAt && input.nominationsOpenAt > now
      ? input.nominationsOpenAt
      : now;
  return {
    nominationsOpenAt: opens,
    nominationsCloseAt: input.nominationsCloseAt,
    votingOpensAt: input.votingOpensAt,
    votingClosesAt: input.votingClosesAt,
  };
}

function sizeProblems(input: {
  seats: number;
  termMonths: number;
}): FieldError[] {
  const out: FieldError[] = [];
  const { seats, termMonths } = ELECTION_LIMITS;
  if (input.seats < seats.min || input.seats > seats.max)
    out.push({
      field: 'seats',
      code: FieldErrorCode.INVALID_NUMBER,
      params: { ...seats },
    });
  if (input.termMonths < termMonths.min || input.termMonths > termMonths.max)
    out.push({
      field: 'termMonths',
      code: FieldErrorCode.INVALID_NUMBER,
      params: { ...termMonths },
    });
  return out;
}

function audited(
  e: GovernanceElection,
  c: GovernanceContest,
): Record<string, unknown> {
  return {
    number: e.number,
    seats: e.seats,
    termMonths: e.termMonths,
    nominationsOpenAt: e.nominationsOpenAt.toISOString(),
    nominationsCloseAt: e.nominationsCloseAt.toISOString(),
    votingOpensAt: c.opensAt.toISOString(),
    votingClosesAt: c.closesAt.toISOString(),
    titleEn: e.titleEn,
    titleAr: e.titleAr,
    bodyEn: e.bodyEn,
    bodyAr: e.bodyAr,
  };
}
