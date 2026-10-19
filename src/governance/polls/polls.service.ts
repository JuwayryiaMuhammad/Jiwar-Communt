import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  GovernanceContest,
  GovernancePoll,
  GovernancePollKind,
  GovernancePollOption,
  Prisma,
} from '@prisma/client';
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
import { GovernanceAccess } from '../access';
import {
  contestStatus,
  contestStatusWhere,
  windowProblems,
  type ContestStatus,
} from '../contests/contest-rules';
import { ContestSweeps } from '../contests/contest-sweeps';
import {
  contestNotOpen,
  Contests,
  type MyUnit,
  type RollCallEntry,
} from '../contests/contests.service';
import { BoardService } from '../board/board.service';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import { POLL_LIMITS, pollResult, YES_NO } from './poll-rules';

export const GOVERNANCE_POLL_RESOURCE = 'governance_poll';
export const GOVERNANCE_POLL_VOTE_RESOURCE = 'governance_poll_vote';

const TEXTS = [
  { name: 'title', max: POLL_LIMITS.title },
  { name: 'body', max: POLL_LIMITS.body },
] as const;
const LABEL = [{ name: 'label', max: POLL_LIMITS.optionLabel }] as const;
const PAGE = keysetCursor('createdAt', 'desc');

export interface PollOptionInput {
  labelEn?: string | null;
  labelAr?: string | null;
}

interface PollFields {
  titleEn?: string | null;
  titleAr?: string | null;
  bodyEn?: string | null;
  bodyAr?: string | null;
  kind?: GovernancePollKind;
  options?: PollOptionInput[];
  quorumPct?: number;
  thresholdPct?: number;
  opensAt?: Date;
  closesAt?: Date;
}

export interface NewPoll extends PollFields {
  kind: GovernancePollKind;
  secret: boolean;
  quorumPct: number;
  thresholdPct: number;
  closesAt: Date;
}

export interface PollRecord {
  poll: GovernancePoll;
  contest: GovernanceContest;
  options: GovernancePollOption[];
  status: ContestStatus;
  /** Units that voted so far; null before it opens. */
  turnout: number | null;
  /** The reader's units in it; null for the staff. */
  myUnits: MyUnit[] | null;
  /** An open poll's roll call, once closed; null otherwise. */
  rollCall: RollCallEntry[] | null;
}

export const pollNotFound = () =>
  appError.notFound(ErrorCode.GOVERNANCE_POLL_NOT_FOUND, 'Poll not found');

const started = (status: ContestStatus) =>
  appError.conflict(
    ErrorCode.GOVERNANCE_CONTEST_STARTED,
    'Voting has opened: only a cancel now',
    { params: { status } },
  );

/**
 * The owners' polls (ADR 0051). The board (or the manager for it) puts a
 * question: yes / no / abstain, or one of 2–10 options; a quorum and a
 * pass threshold; secret or open, fixed at creation. Until voting opens
 * anything else may change; then only a cancel. The electorate is taken
 * when it opens; each unit's voting owner votes once; at the close the
 * counts and the result are written once (contests.service.ts).
 */
@Injectable()
export class GovernancePollsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly contests: Contests,
    private readonly sweeps: ContestSweeps,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notices: GovernanceNotices,
    private readonly board: BoardService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(GOVERNANCE_POLL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const poll = await tx.governancePoll.findUniqueOrThrow({
          where: { id },
        });
        return { id: poll.id, number: poll.number };
      }),
    );
    // A vote's replay says the unit voted, and nothing of the choice.
    this.idempotency.renderer(GOVERNANCE_POLL_VOTE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const poll = await tx.governancePoll.findFirstOrThrow({
          where: { contestId: id },
        });
        const mine = await tx.governanceParticipation.findFirst({
          where: { contestId: id, voterAccountId: this.ctx.accountId },
          select: { unitId: true, votedAt: true },
          orderBy: { votedAt: 'desc' },
        });
        return {
          pollId: poll.id,
          unitId: mine?.unitId ?? null,
          votedAt: mine?.votedAt ?? null,
        };
      }),
    );
    this.sweeps.register('poll', {
      open: (tx, contest, now) => this.openContest(tx, contest, now),
      close: (tx, contest) => this.closeContest(tx, contest),
      remind: async (tx, contest, accounts) => {
        const poll = await this.pollOf(tx, contest);
        await this.notices.send(
          tx,
          accounts,
          'governance_poll.closing_soon',
          poll.id,
        );
      },
    });
  }

  // --------------------------------------------------------------------------
  // Writing: the board or the manager
  // --------------------------------------------------------------------------

  create(input: NewPoll): Promise<PollRecord> {
    const texts = localized(input, TEXTS);
    const options = checkedOptions(input.kind, input.options, texts);
    const fields = shareProblems(input);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // Opening at once tells the electorate: its accounts before the seat
      // (by a clock read only for this; the decision's is read after).
      if (opensAtOnce(input.opensAt, await dbNow(tx)))
        await this.access.lockElectorate(tx);
      const author = await this.access.requireAuthor(tx);
      await this.contests.requireRoom(tx);
      const now = await dbNow(tx);
      const opensAt =
        input.opensAt && input.opensAt > now ? input.opensAt : now;
      const window = windowProblems(opensAt, input.closesAt, now);
      if (window.length) throw invalid(window as FieldError[]);
      const id = newId();
      await this.idempotency.claim(tx, { type: GOVERNANCE_POLL_RESOURCE, id });
      const contest = await this.contests.create(tx, {
        kind: 'poll',
        secret: input.secret,
        maxChoices: 1,
        opensAt,
        closesAt: input.closesAt,
        now,
      });
      const poll = await tx.governancePoll.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          contestId: contest.id,
          number: await this.nextNumber(tx),
          kind: input.kind,
          ...texts,
          quorumPct: input.quorumPct,
          thresholdPct: input.thresholdPct,
          authorSide: author.side,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await this.writeOptions(tx, poll, options);
      await this.audit.record(tx, {
        action: 'governance_poll.created',
        targetId: id,
        // The settings by value, the texts as "changed" (the action's
        // `sensitive` list; metadata never holds them as text).
        changes: diffChanges(
          null,
          audited(poll, contest, options.length),
          'governance_poll.created',
        ),
        metadata: { side: author.side },
      });
      if (opensAt <= now) await this.openContest(tx, contest, now);
      return this.load(tx, poll, null);
    });
  }

  /** Before voting opens, anything but its secrecy changes. */
  update(id: string, input: PollFields): Promise<PollRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.governancePoll.findUnique({
        where: { id },
        select: { contestId: true },
      });
      const scheduled = seen
        ? await tx.governanceContest.findUnique({
            where: { id: seen.contestId },
            select: { opensAt: true },
          })
        : null;
      if (
        scheduled &&
        opensAtOnce(input.opensAt ?? scheduled.opensAt, await dbNow(tx))
      )
        await this.access.lockElectorate(tx);
      await this.access.requireAuthor(tx);
      const { poll, contest } = await this.lockPoll(tx, id, 'update');
      const now = await dbNow(tx);
      const status = contestStatus(contest, now);
      if (status !== 'scheduled' || contest.openedAt) throw started(status);
      const texts = localized(input, TEXTS, {
        titleEn: poll.titleEn,
        titleAr: poll.titleAr,
        bodyEn: poll.bodyEn,
        bodyAr: poll.bodyAr,
      });
      const kind = input.kind ?? poll.kind;
      const current = await this.optionsOf(tx, poll.id);
      const options =
        input.options !== undefined || kind !== poll.kind
          ? checkedOptions(kind, input.options, texts)
          : checkedOptions(
              kind,
              kind === 'choice' ? current : undefined,
              texts,
            );
      const merged = {
        quorumPct: input.quorumPct ?? poll.quorumPct,
        thresholdPct: input.thresholdPct ?? poll.thresholdPct,
      };
      const fields = shareProblems(merged);
      if (fields.length) throw invalid(fields);
      const opensAt = input.opensAt
        ? input.opensAt > now
          ? input.opensAt
          : now
        : contest.opensAt;
      const closesAt = input.closesAt ?? contest.closesAt;
      const window = windowProblems(opensAt, closesAt, now);
      if (window.length) throw invalid(window as FieldError[]);

      const before = audited(poll, contest, current.length);
      const updatedContest = await tx.governanceContest.update({
        where: { id: contest.id },
        data: { opensAt, closesAt },
      });
      const updated = await tx.governancePoll.update({
        where: { id },
        data: { kind, ...texts, ...merged },
      });
      await tx.governancePollOption.deleteMany({ where: { pollId: id } });
      await this.writeOptions(tx, updated, options);
      await this.audit.record(tx, {
        action: 'governance_poll.changed',
        targetId: id,
        changes: diffChanges(
          before,
          audited(updated, updatedContest, options.length),
          'governance_poll.changed',
        ),
      });
      if (opensAt <= now) await this.openContest(tx, updatedContest, now);
      return this.load(tx, updated, null);
    });
  }

  /** Ends a poll before its close, with no result, with a reason's code. */
  cancel(id: string, reasonCode: string | undefined): Promise<PollRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.governancePollCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const author = await this.access.requireAuthor(tx);
      const { contest } = await this.lockPoll(tx, id, 'update');
      const now = await dbNow(tx);
      const status = contestStatus(contest, now);
      if (status === 'closed' || status === 'cancelled')
        throw appError.conflict(
          ErrorCode.GOVERNANCE_CONTEST_ENDED,
          'The poll ended already',
          { params: { status } },
        );
      await this.contests.cancel(tx, contest, now);
      const updated = await tx.governancePoll.update({
        where: { id },
        data: { cancelReasonCode: reason, cancelledById: this.ctx.accountId },
      });
      await this.audit.record(tx, {
        action: 'governance_poll.cancelled',
        targetId: id,
        metadata: { fromStatus: status, reasonCode: reason, side: author.side },
      });
      return this.load(tx, updated, null);
    });
  }

  // --------------------------------------------------------------------------
  // Voting: a unit's voting owner
  // --------------------------------------------------------------------------

  /**
   * One unit's vote, once. Its answer says it was taken and when, never
   * what: the same for a secret poll and an open one.
   */
  vote(
    id: string,
    input: { unitId: string; optionIds: string[] },
  ): Promise<{ pollId: string; unitId: string; votedAt: Date }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // No "owns a unit now": the electorate is the snapshot, and the
      // elector check below is the rule (ADR 0051).
      const { poll, contest } = await this.lockPoll(tx, id, 'share');
      const now = await dbNow(tx);
      const status = contestStatus(contest, now);
      if (status !== 'open') throw contestNotOpen(status);
      const options = await this.optionsOf(tx, poll.id);
      const choice = [...new Set(input.optionIds)];
      // Codes only: never the ids sent back, not even in an error.
      if (choice.length !== 1 || input.optionIds.length !== 1)
        throw invalid([
          {
            field: 'optionIds',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { min: 1, max: 1 },
          },
        ]);
      if (!options.some((o) => o.id === choice[0]))
        throw invalid([
          { field: 'optionIds', code: FieldErrorCode.INVALID_VALUE },
        ]);
      await this.idempotency.claim(tx, {
        type: GOVERNANCE_POLL_VOTE_RESOURCE,
        id: contest.id,
      });
      const votedAt = await this.contests.cast(
        tx,
        contest,
        input.unitId,
        choice,
        now,
      );
      return { pollId: poll.id, unitId: input.unitId, votedAt };
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  ownersList(q: {
    status?: ContestStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<PollRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.requireOwner(tx);
      return this.page(tx, q, this.ctx.accountId);
    });
  }

  /** An owner's, or an elector's who no longer owns the unit they vote for. */
  ownersGet(id: string): Promise<PollRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const poll = await tx.governancePoll.findUnique({ where: { id } });
      const me = this.ctx.accountId;
      const elector =
        poll &&
        (await tx.governanceElector.count({
          where: { contestId: poll.contestId, accountId: me },
        }));
      if (!elector) await this.access.requireOwner(tx);
      if (!poll) throw pollNotFound();
      return this.load(tx, poll, me);
    });
  }

  staffList(q: {
    status?: ContestStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<PollRecord>> {
    return this.tenantTx.withTenantTx((tx) => this.page(tx, q, null));
  }

  staffGet(id: string): Promise<PollRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const poll = await tx.governancePoll.findUnique({ where: { id } });
      if (!poll) throw pollNotFound();
      return this.load(tx, poll, null);
    });
  }

  // --------------------------------------------------------------------------
  // The contest's time
  // --------------------------------------------------------------------------

  /** Voting opens: the electorate is taken (the contest is locked for update). */
  async openContest(
    tx: TenantTxClient,
    contest: GovernanceContest,
    now: Date,
  ): Promise<void> {
    const poll = await tx.governancePoll.findFirstOrThrow({
      where: { contestId: contest.id },
    });
    const electors = await this.contests.open(tx, contest, now);
    await this.audit.record(tx, {
      action: 'governance_poll.opened',
      targetId: poll.id,
      // `ballot`, never a key named secret: the audit withholds those.
      metadata: { electorate: electors.length, ballot: ballotOf(contest) },
    });
    await this.notices.send(tx, electors, 'governance_poll.opened', poll.id);
  }

  /** Voting closed: the counts, the turnout and the result, once. */
  async closeContest(
    tx: TenantTxClient,
    contest: GovernanceContest,
  ): Promise<void> {
    const poll = await tx.governancePoll.findFirstOrThrow({
      where: { contestId: contest.id },
    });
    const { turnout, counts } = await this.contests.close(tx, contest);
    const options = await this.optionsOf(tx, poll.id);
    for (const o of options)
      await tx.governancePollOption.update({
        where: { id: o.id },
        data: { finalCount: counts.get(o.id) ?? 0 },
      });
    const { result, winningOptionId } = pollResult({
      kind: poll.kind,
      electorate: contest.electorate ?? 0,
      turnout,
      quorumPct: poll.quorumPct,
      thresholdPct: poll.thresholdPct,
      options: options.map((o) => ({
        id: o.id,
        key: o.key,
        votes: counts.get(o.id) ?? 0,
      })),
    });
    await tx.governancePoll.update({
      where: { id: poll.id },
      data: { result, winningOptionId },
    });
    await this.audit.record(tx, {
      action: 'governance_poll.closed',
      targetId: poll.id,
      metadata: { result, turnout, electorate: contest.electorate ?? 0 },
    });
    const electors = (
      await tx.governanceElector.findMany({
        where: { contestId: contest.id },
        select: { accountId: true },
      })
    ).map((e) => e.accountId);
    await this.notices.send(
      tx,
      [...electors, ...(await this.board.seatedAccounts(tx, await dbNow(tx)))],
      'governance_poll.result',
      poll.id,
      { result },
    );
  }

  private pollOf(tx: TenantTxClient, contest: GovernanceContest) {
    return tx.governancePoll.findFirstOrThrow({
      where: { contestId: contest.id },
    });
  }

  // --------------------------------------------------------------------------

  private async page(
    tx: TenantTxClient,
    q: { status?: ContestStatus; cursor?: string; limit?: number },
    reader: string | null,
  ): Promise<Page<PollRecord>> {
    const limit = clampLimit(q.limit);
    const now = await dbNow(tx);
    let contestIds: string[] | undefined;
    if (q.status)
      contestIds = (
        await tx.governanceContest.findMany({
          where: { kind: 'poll', ...contestStatusWhere(q.status, now) },
          select: { id: true },
        })
      ).map((c) => c.id);
    const rows = await tx.governancePoll.findMany({
      where: {
        AND: [
          ...(contestIds ? [{ contestId: { in: contestIds } }] : []),
          ...PAGE.after(q.cursor),
        ],
      },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    const page = PAGE.toPage(rows, limit);
    const items: PollRecord[] = [];
    for (const poll of page.items)
      items.push(await this.load(tx, poll, reader));
    return { items, nextCursor: page.nextCursor };
  }

  private async load(
    tx: TenantTxClient,
    poll: GovernancePoll,
    reader: string | null,
  ): Promise<PollRecord> {
    const contest = await tx.governanceContest.findUniqueOrThrow({
      where: { id: poll.contestId },
    });
    const now = await dbNow(tx);
    return {
      poll,
      contest,
      options: await this.optionsOf(tx, poll.id),
      status: contestStatus(contest, now),
      turnout: contest.openedAt
        ? (contest.turnout ?? (await this.contests.turnout(tx, contest.id)))
        : null,
      myUnits: reader
        ? await this.contests.myUnits(tx, contest.id, reader)
        : null,
      rollCall: await this.contests.rollCall(tx, contest),
    };
  }

  private async lockPoll(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<{ poll: GovernancePoll; contest: GovernanceContest }> {
    const poll = await tx.governancePoll.findUnique({ where: { id } });
    if (!poll) throw pollNotFound();
    const contest = await this.contests.lock(tx, poll.contestId, mode);
    if (!contest) throw pollNotFound();
    // Read again after the lock: an edit may have committed meanwhile.
    return {
      poll: await tx.governancePoll.findUniqueOrThrow({ where: { id } }),
      contest,
    };
  }

  private optionsOf(tx: TenantTxClient, pollId: string) {
    return tx.governancePollOption.findMany({
      where: { pollId },
      orderBy: { position: 'asc' },
    });
  }

  private async writeOptions(
    tx: TenantTxClient,
    poll: GovernancePoll,
    options: CheckedOption[],
  ): Promise<void> {
    await tx.governancePollOption.createMany({
      data: options.map((o, i) => ({
        id: newId(),
        tenantId: poll.tenantId,
        pollId: poll.id,
        position: i + 1,
        key: o.key,
        labelEn: o.labelEn,
        labelAr: o.labelAr,
      })),
    });
  }

  private async nextNumber(tx: TenantTxClient): Promise<number> {
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO governance_counters (tenant_id, kind, last_number)
      VALUES (${this.ctx.txTenantId}::uuid, 'poll'::governance_contest_kind, 1)
      ON CONFLICT (tenant_id, kind)
        DO UPDATE SET last_number = governance_counters.last_number + 1
      RETURNING last_number AS number`;
    return number;
  }
}

interface CheckedOption {
  key: string | null;
  labelEn: string | null;
  labelAr: string | null;
}

/**
 * A yes/no poll's three fixed options (none may be given); a choice poll's
 * 2–10, each in exactly the languages the poll is written in.
 */
function checkedOptions(
  kind: GovernancePollKind,
  given: readonly PollOptionInput[] | undefined,
  texts: Record<string, string | null>,
): CheckedOption[] {
  if (kind === 'yes_no') {
    if (given?.length)
      throw invalid([
        { field: 'options', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    return YES_NO.map((key) => ({ key, labelEn: null, labelAr: null }));
  }
  const options = given ?? [];
  if (
    options.length < POLL_LIMITS.minOptions ||
    options.length > POLL_LIMITS.maxOptions
  )
    throw invalid([
      {
        field: 'options',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: POLL_LIMITS.minOptions, max: POLL_LIMITS.maxOptions },
      },
    ]);
  const errors: FieldError[] = [];
  const out = options.map((o, i) => {
    const labels = localized(o, LABEL, undefined, `options.${i}.`);
    for (const language of ['En', 'Ar'] as const) {
      const written = texts[`title${language}`] !== null;
      const labelled = labels[`label${language}`] !== null;
      if (written !== labelled)
        errors.push({
          field: `options.${i}.label${language}`,
          code: written
            ? FieldErrorCode.FIELD_REQUIRED
            : FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    }
    return { key: null, labelEn: labels.labelEn, labelAr: labels.labelAr };
  });
  if (errors.length) throw invalid(errors);
  return out;
}

function shareProblems(input: {
  quorumPct?: number;
  thresholdPct?: number;
}): FieldError[] {
  const out: FieldError[] = [];
  const { quorum, threshold } = POLL_LIMITS;
  if (
    input.quorumPct !== undefined &&
    (input.quorumPct < quorum.min || input.quorumPct > quorum.max)
  )
    out.push({
      field: 'quorumPct',
      code: FieldErrorCode.INVALID_NUMBER,
      params: { ...quorum },
    });
  if (
    input.thresholdPct !== undefined &&
    (input.thresholdPct < threshold.min || input.thresholdPct > threshold.max)
  )
    out.push({
      field: 'thresholdPct',
      code: FieldErrorCode.INVALID_NUMBER,
      params: { ...threshold },
    });
  return out;
}

/** What the audit trail records of a poll: its settings by value, its texts as "changed". */
function audited(
  p: GovernancePoll,
  c: GovernanceContest,
  options: number,
): Record<string, unknown> & Prisma.InputJsonObject {
  return {
    number: p.number,
    kind: p.kind,
    ballot: ballotOf(c),
    quorumPct: p.quorumPct,
    thresholdPct: p.thresholdPct,
    opensAt: c.opensAt.toISOString(),
    closesAt: c.closesAt.toISOString(),
    options,
    titleEn: p.titleEn,
    titleAr: p.titleAr,
    bodyEn: p.bodyEn,
    bodyAr: p.bodyAr,
  };
}

/** A contest's ballot, as the audit trail records it. */
const ballotOf = (c: Pick<GovernanceContest, 'secret'>) =>
  c.secret ? 'secret' : 'open';

/** Whether a write's opening time is now or past, by a clock read for this only. */
function opensAtOnce(opensAt: Date | undefined, now: Date): boolean {
  return !opensAt || opensAt <= now;
}
