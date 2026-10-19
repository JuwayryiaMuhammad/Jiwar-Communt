import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { GovernanceContest, GovernanceContestKind } from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { GovernanceAccess } from '../access';
import {
  CONTEST_LIMITS,
  contestStatus,
  type ContestStatus,
} from './contest-rules';

/** One of the caller's units in a contest. */
export interface MyUnit {
  unitId: string;
  unitCode: string;
  voted: boolean;
}

/** An open contest's roll call: who chose what, by unit code. */
export interface RollCallEntry {
  unitCode: string;
  choice: string[];
}

export const contestNotOpen = (status: ContestStatus) =>
  appError.conflict(
    ErrorCode.GOVERNANCE_CONTEST_NOT_OPEN,
    'Voting is not open',
    {
      params: { status },
    },
  );

/**
 * The voting machinery polls and elections share (ADR 0051): the
 * electorate's snapshot when a contest opens, one vote per unit, the close
 * and the cancel. A secret contest's ballot never meets its unit: it is
 * filed in the contest's one ballot box under a random v4 id, by the same
 * statement for every vote, and at the close written out as rows in id
 * order; the participation says only who voted for which unit, and when.
 *
 * Lock order (with GovernanceAccess): the caller's account, then the
 * contest's row (shared by a vote, exclusive by an open, a close, a cancel
 * or an edit), then the box.
 */
@Injectable()
export class Contests {
  constructor(
    private readonly ctx: RequestContext,
    private readonly community: CommunityGovernancePort,
    private readonly audit: AuditService,
    private readonly access: GovernanceAccess,
  ) {}

  async create(
    tx: TenantTxClient,
    input: {
      kind: GovernanceContestKind;
      secret: boolean;
      maxChoices: number;
      opensAt: Date;
      closesAt: Date;
      now: Date;
    },
  ): Promise<GovernanceContest> {
    return tx.governanceContest.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        kind: input.kind,
        secret: input.secret,
        maxChoices: input.maxChoices,
        opensAt: input.opensAt,
        closesAt: input.closesAt,
        createdAt: input.now,
      },
    });
  }

  /** The contest's row, locked, read after the lock; null when unknown. */
  async lock(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<GovernanceContest | null> {
    const rows =
      mode === 'share'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM governance_contests WHERE id = ${id}::uuid FOR SHARE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM governance_contests WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.governanceContest.findUniqueOrThrow({ where: { id } });
  }

  /** Refuses a new contest when the compound has as many under way as it may. */
  async requireRoom(tx: TenantTxClient): Promise<void> {
    const live = await tx.governanceContest.count({
      where: { closedAt: null, cancelledAt: null },
    });
    if (live >= CONTEST_LIMITS.live)
      throw appError.conflict(
        ErrorCode.GOVERNANCE_LIMIT_REACHED,
        'Too many polls and elections are under way',
        { params: { max: CONTEST_LIMITS.live } },
      );
  }

  /**
   * Opens a contest the caller locked for update: its electorate, the
   * voting owner of every unit now, in one statement in unit order; the
   * ballot box when secret. Returns the electors' accounts.
   */
  async open(
    tx: TenantTxClient,
    contest: GovernanceContest,
    now: Date,
  ): Promise<string[]> {
    const owners = [...(await this.community.votingOwners(tx)).entries()].sort(
      ([a], [b]) => (a < b ? -1 : 1),
    );
    // Each elector row key-shares its account. A member's poll locked the
    // electorate before the seat; an owner who joined since is locked late.
    await this.access.lockLate(
      tx,
      owners.map(([, accountId]) => accountId),
    );
    const tenantId = this.ctx.txTenantId;
    if (owners.length)
      await tx.governanceElector.createMany({
        data: owners.map(([unitId, accountId]) => ({
          tenantId,
          contestId: contest.id,
          unitId,
          accountId,
        })),
      });
    await tx.governanceContest.update({
      where: { id: contest.id },
      data: { openedAt: now, electorate: owners.length },
    });
    if (contest.secret)
      await tx.governanceBallotBox.create({
        data: { tenantId, contestId: contest.id },
      });
    return owners.map(([, accountId]) => accountId);
  }

  /**
   * One unit's vote, by its elector, on a contest the caller locked shared
   * and found open. A secret contest's ballot goes into its box under a
   * random v4 id; an open one's choice stays with the unit.
   */
  async cast(
    tx: TenantTxClient,
    contest: GovernanceContest,
    unitId: string,
    choice: readonly string[],
    now: Date,
  ): Promise<Date> {
    const me = this.ctx.accountId;
    const elector = await tx.governanceElector.findUnique({
      where: {
        tenantId_contestId_unitId: {
          tenantId: this.ctx.txTenantId,
          contestId: contest.id,
          unitId,
        },
      },
    });
    if (elector?.accountId !== me)
      throw appError.forbidden(
        ErrorCode.GOVERNANCE_NOT_ELECTOR,
        'The caller does not cast this unit’s vote',
      );
    // Votes on one secret contest go one after the other, on its box.
    if (contest.secret)
      await tx.$queryRaw`
        SELECT contest_id FROM governance_ballot_boxes
         WHERE contest_id = ${contest.id}::uuid FOR UPDATE`;
    const voted = await tx.governanceParticipation.count({
      where: { contestId: contest.id, unitId },
    });
    if (voted)
      throw appError.conflict(
        ErrorCode.GOVERNANCE_ALREADY_VOTED,
        'The unit voted already',
      );
    const tenantId = this.ctx.txTenantId;
    if (contest.secret) {
      await tx.$executeRaw`
        INSERT INTO governance_participations
          (tenant_id, contest_id, unit_id, voter_account_id, voted_at, secret)
        VALUES (${tenantId}::uuid, ${contest.id}::uuid, ${unitId}::uuid,
                ${me}::uuid, ${now}, true)`;
      await tx.$executeRaw`
        UPDATE governance_ballot_boxes
           SET ballots = ballots || jsonb_build_object(${randomUUID()}::text, ${JSON.stringify(choice)}::jsonb)
         WHERE contest_id = ${contest.id}::uuid`;
    } else {
      await tx.$executeRaw`
        INSERT INTO governance_participations
          (tenant_id, contest_id, unit_id, voter_account_id, voted_at, secret, choice)
        VALUES (${tenantId}::uuid, ${contest.id}::uuid, ${unitId}::uuid,
                ${me}::uuid, ${now}, false, ${[...choice]}::uuid[])`;
    }
    await this.audit.record(tx, {
      action: 'governance.vote_cast',
      targetId: contest.id,
      metadata: { kind: contest.kind, unitId },
    });
    return now;
  }

  /**
   * Closes a contest the caller locked for update, at its closing time:
   * the votes per choice, counted in the database (no ballot is read out);
   * a secret one's ballots written out as rows in id order, and its box
   * deleted.
   */
  async close(
    tx: TenantTxClient,
    contest: GovernanceContest,
  ): Promise<{ turnout: number; counts: Map<string, number> }> {
    const id = contest.id;
    const rows = contest.secret
      ? await tx.$queryRaw<{ choice: string; n: number }[]>`
          SELECT c.choice, count(*)::int AS n
            FROM governance_ballot_boxes b,
                 jsonb_each(b.ballots) AS e(key, value),
                 jsonb_array_elements_text(e.value) AS c(choice)
           WHERE b.contest_id = ${id}::uuid
           GROUP BY c.choice`
      : await tx.$queryRaw<{ choice: string; n: number }[]>`
          SELECT c.choice::text AS choice, count(*)::int AS n
            FROM governance_participations p, unnest(p.choice) AS c(choice)
           WHERE p.contest_id = ${id}::uuid
           GROUP BY c.choice`;
    const turnout = await tx.governanceParticipation.count({
      where: { contestId: id },
    });
    await tx.governanceContest.update({
      where: { id },
      // It closed at its closing time: that is when votes stopped.
      data: { closedAt: contest.closesAt, turnout },
    });
    if (contest.secret) {
      await tx.$executeRaw`
        INSERT INTO governance_ballots (id, tenant_id, contest_id, choice)
        SELECT e.key::uuid, b.tenant_id, b.contest_id,
               ARRAY(SELECT jsonb_array_elements_text(e.value)::uuid)
          FROM governance_ballot_boxes b, jsonb_each(b.ballots) AS e(key, value)
         WHERE b.contest_id = ${id}::uuid
         ORDER BY e.key`;
      await tx.$executeRaw`
        DELETE FROM governance_ballot_boxes WHERE contest_id = ${id}::uuid`;
    }
    return { turnout, counts: new Map(rows.map((r) => [r.choice, r.n])) };
  }

  /** Ends a contest the caller locked for update, with no result. */
  async cancel(
    tx: TenantTxClient,
    contest: GovernanceContest,
    now: Date,
  ): Promise<void> {
    await tx.governanceContest.update({
      where: { id: contest.id },
      data: { cancelledAt: now },
    });
    await tx.$executeRaw`
      DELETE FROM governance_ballot_boxes WHERE contest_id = ${contest.id}::uuid`;
  }

  /** Units that voted so far. */
  turnout(tx: TenantTxClient, contestId: string): Promise<number> {
    return tx.governanceParticipation.count({ where: { contestId } });
  }

  /** The units whose vote the account casts in the contest, and whether each voted. */
  async myUnits(
    tx: TenantTxClient,
    contestId: string,
    accountId: string,
  ): Promise<MyUnit[]> {
    const electors = await tx.governanceElector.findMany({
      where: { contestId, accountId },
      select: { unitId: true },
      orderBy: { unitId: 'asc' },
    });
    if (!electors.length) return [];
    const unitIds = electors.map((e) => e.unitId);
    const voted = new Set(
      (
        await tx.governanceParticipation.findMany({
          where: { contestId, unitId: { in: unitIds } },
          select: { unitId: true },
        })
      ).map((p) => p.unitId),
    );
    const codes = await this.community.unitCodes(tx, unitIds);
    return unitIds.map((unitId) => ({
      unitId,
      unitCode: codes.get(unitId) ?? '',
      voted: voted.has(unitId),
    }));
  }

  /**
   * An open (not secret) contest's roll call once closed: each unit that
   * voted, by its code, and its choice. Never for a secret one: there is
   * nothing to read.
   */
  async rollCall(
    tx: TenantTxClient,
    contest: GovernanceContest,
  ): Promise<RollCallEntry[] | null> {
    if (contest.secret || !contest.closedAt) return null;
    const rows = await tx.$queryRaw<{ unit_id: string; choice: string[] }[]>`
      SELECT unit_id, choice::text[] AS choice FROM governance_participations
       WHERE contest_id = ${contest.id}::uuid`;
    const codes = await this.community.unitCodes(
      tx,
      rows.map((r) => r.unit_id),
    );
    return rows
      .map((r) => ({ unitCode: codes.get(r.unit_id) ?? '', choice: r.choice }))
      .sort((a, b) => a.unitCode.localeCompare(b.unitCode));
  }

  status(contest: GovernanceContest, now: Date): ContestStatus {
    return contestStatus(contest, now);
  }
}
