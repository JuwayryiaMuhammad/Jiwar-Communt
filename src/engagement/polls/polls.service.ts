import { randomBytes } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Poll, PollOption, Prisma } from '@prisma/client';
import { CommunityEngagementPort, type Audience } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { EngagementAccess } from '../access';
import {
  audienceColumns,
  audienceOf,
  audienceWhere,
  placesIn,
  sees,
} from '../audience/audience';
import { AudienceCheck } from '../audience/audience-check';
import { invalid, localized } from '../content/localized';
import { dbNow } from '../db-clock';
import { OpaqueRefs } from '../refs/opaque-refs';
import {
  choiceProblem,
  OPTION_LABEL_MAX,
  pollStatus,
  pollStatusWhere,
  QUESTION_MAX,
  resultsHidden,
  type PollStatus,
  type ResultsHidden,
} from './poll-rules';

export const POLL_RESOURCE = 'poll';
export const POLL_VOTE_RESOURCE = 'poll_vote';
export const POLL_CLOSE_SWEEP = 'engagement.poll_close';
const POLL_CLOSE_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 50;

const QUESTION = [{ name: 'question', max: QUESTION_MAX }] as const;

export interface PollOptionInput {
  labelEn?: string | null;
  labelAr?: string | null;
}

interface PollContent {
  questionEn?: string | null;
  questionAr?: string | null;
  multiple?: boolean;
  audience?: { buildings?: string[] | null; occupancy: Audience['occupancy'] };
}

export interface NewPoll extends PollContent {
  options: PollOptionInput[];
  opensAt?: Date;
  closesAt: Date;
}

export interface PollUpdate extends PollContent {
  options?: PollOptionInput[];
  opensAt?: Date;
  closesAt?: Date;
}

export interface VoteInput {
  unitId?: string;
  optionIds: string[];
}

/** One of the reader's units in a poll. */
export interface UnitBallot {
  unitId: string;
  /** The reader casts this unit's vote in this poll. */
  mayVote: boolean;
  voted: boolean;
  /**
   * The unit's choice now: only while the poll is open, and only to those
   * who cast its vote, so they can change it knowingly. Null otherwise.
   */
  choice: string[] | null;
}

export interface PollRead {
  poll: Poll;
  options: PollOption[];
  status: PollStatus;
  /** Units that voted; null while withheld. */
  turnout: number | null;
  /** Votes per option id; null while withheld. */
  counts: Map<string, number> | null;
  hidden: ResultsHidden;
  /** The reader's units in the poll; null for the staff. */
  units: UnitBallot[] | null;
}

const byClosing = keysetCursor('closesAt');
const byCreation = keysetCursor('createdAt');

export const pollNotFound = () =>
  appError.notFound(ErrorCode.POLL_NOT_FOUND, 'Poll not found');

const wrongState = (status: PollStatus) =>
  appError.conflict(
    ErrorCode.POLL_INVALID_STATE,
    'The poll does not take this action now',
    { params: { status } },
  );

/**
 * What the audit trail records of a poll: its settings by value, the
 * number of its options, and its question as "changed" only.
 */
function audited(p: Poll, options: number) {
  return {
    multiple: p.multiple,
    opensAt: p.opensAt,
    closesAt: p.closesAt,
    audienceOccupancy: p.audienceOccupancy,
    audienceBuildings: p.audienceBuildings,
    options,
    questionEn: p.questionEn,
    questionAr: p.questionAr,
  };
}

/** The options, each in exactly the languages the question is written in. */
function checkedOptions(
  options: readonly PollOptionInput[],
  question: { questionEn: string | null; questionAr: string | null },
): { labelEn: string | null; labelAr: string | null }[] {
  const errors: FieldError[] = [];
  const out = options.map((option, i) => {
    const labels = {
      labelEn: option.labelEn?.trim() || null,
      labelAr: option.labelAr?.trim() || null,
    };
    for (const [label, asked] of [
      ['labelEn', question.questionEn],
      ['labelAr', question.questionAr],
    ] as const) {
      const text = labels[label];
      const field = `options.${i}.${label}`;
      if (asked !== null && text === null)
        errors.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
      else if (asked === null && text !== null)
        errors.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
      else if (text !== null && text.length > OPTION_LABEL_MAX)
        errors.push({
          field,
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: OPTION_LABEL_MAX },
        });
    }
    return labels;
  });
  if (errors.length) throw invalid(errors);
  return out;
}

/**
 * Consultative polls (ADR 0040): one vote per unit, a secret ballot.
 *
 * Who votes for a unit is the community domain's rule (`mayVote`): the
 * primary occupant or a member given `polls_vote`; any owner, for a poll
 * put to the owners. A vote may be changed until the poll closes.
 *
 * The ballot is secret against the database. A unit's ballot is filed
 * under a keyed reference (`OpaqueRefs.ballot`) in the poll's one ballot
 * box row; nothing stored says which unit a reference is, and the server
 * can derive it only while the poll is open, which is how it tells a
 * unit's own voters their current choice and lets them change it. Closing
 * or cancelling a poll writes the counts (closing only), deletes the box
 * and clears the salt: from then on not even the server can tell. The API
 * returns a unit's choice to that unit's voters alone, never to the staff.
 *
 * Counts are withheld from everyone while fewer than five units have voted
 * on an open poll (`resultsHidden`).
 */
@Injectable()
export class PollsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: EngagementAccess,
    private readonly community: CommunityEngagementPort,
    private readonly audiences: AudienceCheck,
    private readonly refs: OpaqueRefs,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(POLL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const p = await tx.poll.findUniqueOrThrow({ where: { id } });
        return { id: p.id, createdAt: p.createdAt };
      }),
    );
    // A vote's replay says the vote was taken, and nothing of the choice.
    this.idempotency.renderer(POLL_VOTE_RESOURCE, (id) =>
      Promise.resolve({ pollId: id }),
    );
    this.sweep.register(POLL_CLOSE_SWEEP, (now) => this.closeDue(now), {
      intervalMs: POLL_CLOSE_INTERVAL_MS,
    });
  }

  // --------------------------------------------------------------------------
  // Writing (staff)
  // --------------------------------------------------------------------------

  create(input: NewPoll): Promise<Poll> {
    const question = localized(input, QUESTION) as {
      questionEn: string | null;
      questionAr: string | null;
    };
    const options = checkedOptions(input.options, question);
    const tenantId = this.ctx.tenantId;
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: POLL_RESOURCE, id });
      await this.access.lockSelf(tx);
      const audience = await this.audiences.check(tx, input.audience);
      const now = await dbNow(tx);
      const opensAt =
        input.opensAt && input.opensAt > now ? input.opensAt : now;
      if (input.closesAt <= opensAt)
        throw invalid([
          { field: 'closesAt', code: FieldErrorCode.ENDS_BEFORE_START },
        ]);
      const poll = await tx.poll.create({
        data: {
          id,
          tenantId,
          ...question,
          multiple: input.multiple ?? false,
          opensAt,
          closesAt: input.closesAt,
          ...audienceColumns(audience),
          ballotSalt: new Uint8Array(randomBytes(32)),
          createdById: me,
          createdAt: now,
        },
      });
      await this.writeOptions(tx, poll, options);
      await tx.pollBallotBox.create({ data: { tenantId, pollId: id } });
      await this.audit.record(tx, {
        action: 'poll.created',
        targetId: id,
        changes: diffChanges(
          null,
          audited(poll, options.length),
          'poll.created',
        ),
      });
      return poll;
    });
  }

  /**
   * Before a poll opens anything may change. Once it is open only its
   * closing time may: a question or an option that moved under the ballots
   * already cast would change what they meant.
   */
  update(id: string, input: PollUpdate): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const now = await dbNow(tx);
      const status = pollStatus(before, now);
      if (status !== 'scheduled' && status !== 'open') throw wrongState(status);
      const beforeOptions = await this.optionsOf(tx, id);
      const onlyClosing =
        input.questionEn === undefined &&
        input.questionAr === undefined &&
        input.multiple === undefined &&
        input.audience === undefined &&
        input.options === undefined &&
        input.opensAt === undefined;
      if (status === 'open' && !onlyClosing) throw wrongState(status);

      const question = localized(input, QUESTION, {
        questionEn: before.questionEn,
        questionAr: before.questionAr,
      }) as { questionEn: string | null; questionAr: string | null };
      // The options follow the question's languages, changed or not.
      const options = checkedOptions(
        input.options ??
          beforeOptions.map((o) => ({
            labelEn: o.labelEn,
            labelAr: o.labelAr,
          })),
        question,
      );
      const audience = input.audience
        ? audienceColumns(await this.audiences.check(tx, input.audience))
        : audienceColumns(audienceOf(before));
      const opensAt =
        input.opensAt === undefined
          ? before.opensAt
          : input.opensAt > now
            ? input.opensAt
            : now;
      const closesAt = input.closesAt ?? before.closesAt;
      if (closesAt <= opensAt || closesAt <= now)
        throw invalid([
          { field: 'closesAt', code: FieldErrorCode.ENDS_BEFORE_START },
        ]);
      const after = await tx.poll.update({
        where: { id },
        data: {
          ...question,
          multiple: input.multiple ?? before.multiple,
          opensAt,
          closesAt,
          ...audience,
        },
      });
      if (input.options) {
        await tx.pollOption.deleteMany({ where: { pollId: id } });
        await this.writeOptions(tx, after, options);
      }
      const changes = diffChanges(
        audited(before, beforeOptions.length),
        audited(after, options.length),
        'poll.changed',
      );
      // The same number of options may still be other options.
      const optionsReplaced = input.options !== undefined;
      if (Object.keys(changes).length || optionsReplaced)
        await this.audit.record(tx, {
          action: 'poll.changed',
          targetId: id,
          changes,
          metadata: { optionsReplaced },
        });
    });
  }

  /** Closes an open poll now, ahead of its time. */
  close(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const poll = await this.locked(tx, id);
      const now = await dbNow(tx);
      const status = pollStatus(poll, now);
      // Open, or past its time and not yet swept: both are closed here.
      if (poll.closedAt || (status !== 'open' && status !== 'closed'))
        throw wrongState(status);
      await this.finalize(tx, poll, now, 'closed');
    });
  }

  /**
   * Ends a poll with no result: the ballots are destroyed as at a close,
   * and nothing is counted.
   */
  cancel(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const poll = await this.locked(tx, id);
      const now = await dbNow(tx);
      const status = pollStatus(poll, now);
      if (status !== 'scheduled' && status !== 'open') throw wrongState(status);
      await this.finalize(tx, poll, now, 'cancelled');
    });
  }

  /**
   * The sweep: polls whose closing time has passed. One transaction per
   * poll, taken with SKIP LOCKED: a vote still committing holds the row,
   * and the next run closes it.
   */
  closeDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const due = await tx.poll.findMany({
          where: { closedAt: null, cancelledAt: null, closesAt: { lte: now } },
          orderBy: [{ closesAt: 'asc' }, { id: 'asc' }],
          take: SWEEP_BATCH,
          select: { id: true },
        });
        return due.map((p) => p.id);
      },
      async (tx, _tenantId, id) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM polls
           WHERE id = ${id}::uuid AND closed_at IS NULL AND cancelled_at IS NULL
             FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const poll = await tx.poll.findUniqueOrThrow({ where: { id } });
        if (poll.closesAt > now) return 0;
        await this.finalize(tx, poll, now, 'closed');
        return 1;
      },
    );
  }

  /**
   * The end of a poll, under its row lock. A close counts first: the
   * options' final counts, the turnout, and which units took part (for all
   * units at once, in unit order, so the rows say nothing of when each
   * voted). Then, for a close and a cancellation alike, the box is deleted
   * and the salt cleared: nothing individual is left, and no reference can
   * be derived again.
   */
  private async finalize(
    tx: TenantTxClient,
    poll: Poll,
    now: Date,
    how: 'closed' | 'cancelled',
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT poll_id FROM poll_ballot_boxes WHERE poll_id = ${poll.id}::uuid FOR UPDATE`;
    let turnout: number | null = null;
    if (how === 'closed') {
      const counts = await this.tally(tx, poll.id);
      for (const option of await this.optionsOf(tx, poll.id))
        await tx.pollOption.update({
          where: { id: option.id },
          data: { finalCount: counts.get(option.id) ?? 0 },
        });
      const keys = new Set(
        (
          await tx.$queryRaw<{ key: string }[]>`
            SELECT k.key FROM poll_ballot_boxes b, jsonb_object_keys(b.ballots) AS k(key)
             WHERE b.poll_id = ${poll.id}::uuid`
        ).map((r) => r.key),
      );
      turnout = keys.size;
      const voted = (await this.community.unitIds(tx)).filter((unitId) =>
        keys.has(this.key(poll, unitId)!),
      );
      if (voted.length)
        await tx.pollParticipation.createMany({
          data: voted.map((unitId) => ({
            tenantId: poll.tenantId,
            pollId: poll.id,
            unitId,
          })),
        });
    }
    await tx.pollBallotBox.deleteMany({ where: { pollId: poll.id } });
    await tx.poll.update({
      where: { id: poll.id },
      data:
        how === 'closed'
          ? { ballotSalt: null, closedAt: now, finalTurnout: turnout }
          : { ballotSalt: null, cancelledAt: now },
    });
    await this.audit.record(tx, {
      action: how === 'closed' ? 'poll.closed' : 'poll.cancelled',
      targetId: poll.id,
      metadata:
        how === 'closed'
          ? { turnout: turnout ?? 0, early: now < poll.closesAt }
          : { fromStatus: pollStatus(poll, now) },
    });
  }

  // --------------------------------------------------------------------------
  // Voting (residents)
  // --------------------------------------------------------------------------

  /**
   * Casts, or changes, a unit's vote in an open poll. The poll's row is
   * share-locked: a close waits for a vote in flight, and a vote that
   * arrives after the closing time is refused by the database's clock.
   * Then the ballot box row is locked: the votes of a poll go one after
   * the other, and a unit has one ballot because it has one reference.
   */
  vote(pollId: string, input: VoteInput): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.idempotency.claim(tx, {
        type: POLL_VOTE_RESOURCE,
        id: pollId,
      });
      await this.access.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM polls WHERE id = ${pollId}::uuid FOR SHARE`;
      const poll = await tx.poll.findUnique({ where: { id: pollId } });
      const places = await this.community.places(tx, me);
      if (!poll || !sees(places, poll)) throw pollNotFound();
      const now = await dbNow(tx);
      const status = pollStatus(poll, now);
      if (status !== 'open') throw wrongState(status);

      const votable = await this.community.votableUnits(
        tx,
        me,
        audienceOf(poll),
      );
      if (!votable.length)
        throw appError.forbidden(
          ErrorCode.POLL_VOTE_NOT_ALLOWED,
          'The unit’s vote is cast by its primary resident, a member they gave it to, or its owner',
        );
      const unitId =
        input.unitId ?? (votable.length === 1 ? votable[0] : undefined);
      if (!unitId)
        throw invalid([
          { field: 'unitId', code: FieldErrorCode.FIELD_REQUIRED },
        ]);
      if (!votable.includes(unitId))
        throw invalid([
          { field: 'unitId', code: FieldErrorCode.INVALID_VALUE },
        ]);

      const options = await this.optionsOf(tx, pollId);
      const problem = choiceProblem(
        input.optionIds,
        options.map((o) => o.id),
        poll.multiple,
      );
      if (problem)
        throw invalid([
          problem.index === -1
            ? {
                field: 'optionIds',
                code: FieldErrorCode.INVALID_LENGTH,
                params: { min: 1, max: problem.max },
              }
            : {
                field: `optionIds.${problem.index}`,
                code: FieldErrorCode.INVALID_VALUE,
              },
        ]);

      const key = this.key(poll, unitId)!;
      // In the options' order, whatever order they were picked in.
      const choice = options
        .filter((o) => input.optionIds.includes(o.id))
        .map((o) => o.id);
      const [box] = await tx.$queryRaw<{ voted: boolean }[]>`
        SELECT jsonb_exists(ballots, ${key}) AS voted
          FROM poll_ballot_boxes WHERE poll_id = ${pollId}::uuid FOR UPDATE`;
      await tx.$executeRaw`
        UPDATE poll_ballot_boxes
           SET ballots = ballots || jsonb_build_object(${key}::text, ${JSON.stringify(choice)}::jsonb)
         WHERE poll_id = ${pollId}::uuid`;
      await this.audit.record(tx, {
        action: 'poll.vote_cast',
        targetId: pollId,
        // That the unit voted, and by whom: never what it chose.
        metadata: { unitId, changed: box.voted },
      });
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  listForStaff(q: {
    status?: PollStatus;
    cursor?: string;
    limit: number;
  }): Promise<Page<PollRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const rows = await tx.poll.findMany({
        where: {
          AND: [
            q.status ? pollStatusWhere(q.status, now) : {},
            ...byCreation.after(q.cursor),
          ],
        },
        orderBy: byCreation.orderBy,
        take: q.limit + 1,
      });
      const page = byCreation.toPage(rows, q.limit);
      const items: PollRead[] = [];
      for (const poll of page.items)
        items.push(await this.read(tx, poll, now, null));
      return { ...page, items };
    });
  }

  getForStaff(id: string): Promise<PollRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const poll = await tx.poll.findUnique({ where: { id } });
      if (!poll) throw pollNotFound();
      return this.read(tx, poll, await dbNow(tx), null);
    });
  }

  /** How many units a poll is put to right now (the staff's turnout base). */
  audienceUnits(id: string): Promise<number> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const poll = await tx.poll.findUnique({ where: { id } });
      if (!poll) throw pollNotFound();
      return (await this.audiences.size(tx, audienceOf(poll))).units;
    });
  }

  /**
   * The polls put to the caller that have opened, the latest to close
   * first. One that has not opened yet is the staff's alone.
   */
  list(q: { cursor?: string; limit: number }): Promise<Page<PollRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const places = await this.community.places(tx, me);
      const where: Prisma.PollWhereInput = {
        AND: [
          { opensAt: { lte: now } },
          audienceWhere(places),
          ...byClosing.after(q.cursor),
        ],
      };
      const rows = await tx.poll.findMany({
        where,
        orderBy: byClosing.orderBy,
        take: q.limit + 1,
      });
      const page = byClosing.toPage(rows, q.limit);
      const items: PollRead[] = [];
      for (const poll of page.items)
        items.push(await this.read(tx, poll, now, me));
      return { ...page, items };
    });
  }

  one(id: string): Promise<PollRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const poll = await tx.poll.findUnique({ where: { id } });
      const places = await this.community.places(tx, me);
      if (!poll || poll.opensAt > now || !sees(places, poll))
        throw pollNotFound();
      return this.read(tx, poll, now, me);
    });
  }

  /**
   * The daily brief's polls (ADR 0040): open ones closing before `until`
   * in which the caller casts the vote of a unit that has not voted.
   * Inside the brief's transaction.
   */
  async forBrief(
    tx: TenantTxClient,
    accountId: string,
    now: Date,
    until: Date,
  ): Promise<{ read: PollRead; pendingUnitIds: string[] }[]> {
    const places = await this.community.places(tx, accountId);
    const rows = await tx.poll.findMany({
      where: {
        AND: [
          pollStatusWhere('open', now),
          { closesAt: { lte: until } },
          audienceWhere(places),
        ],
      },
      orderBy: [{ closesAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    const out: { read: PollRead; pendingUnitIds: string[] }[] = [];
    for (const poll of rows) {
      const read = await this.read(tx, poll, now, accountId);
      const pendingUnitIds = (read.units ?? [])
        .filter((u) => u.mayVote && !u.voted)
        .map((u) => u.unitId);
      if (pendingUnitIds.length) out.push({ read, pendingUnitIds });
    }
    return out;
  }

  /**
   * Whether each unit voted in each poll, for a personal-data export:
   * "voted: yes or no", and never anything else. Open polls are answered
   * from the ballot box, closed ones from the participations.
   */
  async participation(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<{ poll: Poll; unitId: string; voted: boolean }[]> {
    if (!unitIds.length) return [];
    const now = await dbNow(tx);
    const polls = await tx.poll.findMany({
      where: { cancelledAt: null, opensAt: { lte: now } },
      orderBy: byCreation.orderBy,
    });
    const out: { poll: Poll; unitId: string; voted: boolean }[] = [];
    for (const poll of polls) {
      const ballots = await this.ballotsOf(tx, poll, unitIds);
      for (const unitId of unitIds)
        out.push({ poll, unitId, voted: ballots.has(unitId) });
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Pieces
  // --------------------------------------------------------------------------

  private async locked(tx: TenantTxClient, id: string): Promise<Poll> {
    await tx.$queryRaw`SELECT id FROM polls WHERE id = ${id}::uuid FOR UPDATE`;
    const poll = await tx.poll.findUnique({ where: { id } });
    if (!poll) throw pollNotFound();
    return poll;
  }

  private optionsOf(tx: TenantTxClient, pollId: string): Promise<PollOption[]> {
    return tx.pollOption.findMany({
      where: { pollId },
      orderBy: { position: 'asc' },
    });
  }

  private async writeOptions(
    tx: TenantTxClient,
    poll: Pick<Poll, 'id' | 'tenantId'>,
    options: readonly { labelEn: string | null; labelAr: string | null }[],
  ): Promise<void> {
    await tx.pollOption.createMany({
      data: options.map((o, i) => ({
        id: newId(),
        tenantId: poll.tenantId,
        pollId: poll.id,
        position: i + 1,
        ...o,
      })),
    });
  }

  /**
   * The key a unit's ballot is filed under, or null once the poll's salt is
   * gone. The only way from a unit to its ballot, and it needs the secret.
   */
  private key(
    poll: Pick<Poll, 'id' | 'ballotSalt'>,
    unitId: string,
  ): string | null {
    return poll.ballotSalt
      ? Buffer.from(
          this.refs.ballot(poll.ballotSalt, poll.id, unitId),
        ).toString('base64url')
      : null;
  }

  /** Votes per option, from the box. Counted in the database: no ballot is read out. */
  private async tally(
    tx: TenantTxClient,
    pollId: string,
  ): Promise<Map<string, number>> {
    const rows = await tx.$queryRaw<{ option_id: string; votes: number }[]>`
      SELECT o.option_id, count(*)::int AS votes
        FROM poll_ballot_boxes b,
             jsonb_each(b.ballots) AS e(key, choice),
             jsonb_array_elements_text(e.choice) AS o(option_id)
       WHERE b.poll_id = ${pollId}::uuid
       GROUP BY o.option_id`;
    return new Map(rows.map((r) => [r.option_id, r.votes]));
  }

  private async turnoutOf(tx: TenantTxClient, poll: Poll): Promise<number> {
    if (poll.finalTurnout !== null) return poll.finalTurnout;
    const [row] = await tx.$queryRaw<{ units: number }[]>`
      SELECT count(*)::int AS units
        FROM poll_ballot_boxes b, jsonb_object_keys(b.ballots) AS k(key)
       WHERE b.poll_id = ${poll.id}::uuid`;
    return row?.units ?? 0;
  }

  /**
   * Which of the units voted, and what each chose while that can still be
   * told (an open poll). After the end: who took part, from the
   * participations, and no choice.
   */
  private async ballotsOf(
    tx: TenantTxClient,
    poll: Poll,
    unitIds: readonly string[],
  ): Promise<Map<string, string[] | null>> {
    const out = new Map<string, string[] | null>();
    if (!unitIds.length) return out;
    if (!poll.ballotSalt) {
      const rows = await tx.pollParticipation.findMany({
        where: { pollId: poll.id, unitId: { in: [...unitIds] } },
        select: { unitId: true },
      });
      for (const r of rows) out.set(r.unitId, null);
      return out;
    }
    const keys = new Map(unitIds.map((u) => [this.key(poll, u)!, u]));
    const rows = await tx.$queryRaw<{ key: string; choice: string[] }[]>`
      SELECT k.key, b.ballots -> k.key AS choice
        FROM poll_ballot_boxes b, unnest(${[...keys.keys()]}::text[]) AS k(key)
       WHERE b.poll_id = ${poll.id}::uuid AND jsonb_exists(b.ballots, k.key)`;
    for (const r of rows) out.set(keys.get(r.key)!, r.choice);
    return out;
  }

  /** A poll as `reader` may see it: an account, or null for the staff. */
  private async read(
    tx: TenantTxClient,
    poll: Poll,
    now: Date,
    reader: string | null,
  ): Promise<PollRead> {
    const status = pollStatus(poll, now);
    const options = await this.optionsOf(tx, poll.id);
    const turnout = await this.turnoutOf(tx, poll);

    let units: UnitBallot[] | null = null;
    if (reader) {
      const places = await this.community.places(tx, reader);
      const mine = placesIn(places, poll).map((p) => p.unitId);
      const votable = await this.community.votableUnits(
        tx,
        reader,
        audienceOf(poll),
      );
      const ballots = await this.ballotsOf(tx, poll, mine);
      units = mine.map((unitId) => {
        const mayVote = votable.includes(unitId);
        return {
          unitId,
          mayVote,
          voted: ballots.has(unitId),
          choice:
            status === 'open' && mayVote ? (ballots.get(unitId) ?? null) : null,
        };
      });
    }

    const hidden = resultsHidden(
      status,
      units ? { voted: units.some((u) => u.voted) } : 'staff',
      turnout,
    );
    let counts: Map<string, number> | null = null;
    if (hidden === null) {
      const live = poll.closedAt ? null : await this.tally(tx, poll.id);
      counts = new Map(
        options.map((o) => [o.id, o.finalCount ?? live?.get(o.id) ?? 0]),
      );
    }
    return {
      poll,
      options,
      status,
      turnout: hidden === null ? turnout : null,
      counts,
      hidden,
      units,
    };
  }
}
