import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { GovernanceContest, GovernanceContestKind } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { CONTEST_LIMITS } from './contest-rules';

export const CONTEST_OPEN_SWEEP = 'governance.open';
export const CONTEST_CLOSE_SWEEP = 'governance.close';
export const CONTEST_REMIND_SWEEP = 'governance.remind';
const INTERVAL_MS = 60_000;
const BATCH = 50;

/**
 * What a poll or an election does when its contest's time comes, in the
 * sweep's transaction, the contest's row locked for update and judged
 * again: open it (its electorate, its box, who is told), close it (its
 * counts and result). The kind registers itself.
 */
export interface ContestHandler {
  open(
    tx: TenantTxClient,
    contest: GovernanceContest,
    now: Date,
  ): Promise<void>;
  close(
    tx: TenantTxClient,
    contest: GovernanceContest,
    now: Date,
  ): Promise<void>;
  /** Tells `accounts` (electors whose unit has not voted) it closes soon. */
  remind(
    tx: TenantTxClient,
    contest: GovernanceContest,
    accounts: string[],
  ): Promise<void>;
}

/**
 * The two governance sweeps (ADR 0051), every minute, one contest per
 * transaction, taken with SKIP LOCKED: a vote still committing holds the
 * contest's row shared, and the next run takes it. A contest the open
 * missed (the window passed while the server was down) is opened, then
 * closed: its electorate stands, nobody voted.
 */
@Injectable()
export class ContestSweeps implements OnModuleInit {
  private readonly handlers = new Map<GovernanceContestKind, ContestHandler>();

  constructor(private readonly sweep: SweepRunner) {}

  register(kind: GovernanceContestKind, handler: ContestHandler): void {
    if (this.handlers.has(kind))
      throw new Error(`A contest handler for ${kind} is registered twice`);
    this.handlers.set(kind, handler);
  }

  onModuleInit(): void {
    this.sweep.register(CONTEST_OPEN_SWEEP, (now) => this.openDue(now), {
      intervalMs: INTERVAL_MS,
    });
    this.sweep.register(CONTEST_CLOSE_SWEEP, (now) => this.closeDue(now), {
      intervalMs: INTERVAL_MS,
    });
    this.sweep.register(CONTEST_REMIND_SWEEP, (now) => this.remindDue(now), {
      intervalMs: INTERVAL_MS,
    });
  }

  /**
   * The reminder a day before voting closes, once: "once" is `reminded_at`,
   * claimed with a conditional update, so of two sweeps one claims it and
   * the other tells nobody. A contest that opened less than a day before
   * its close is claimed and tells nobody: everyone heard it opened.
   */
  remindDue(now: Date): Promise<number> {
    const until = new Date(now.getTime() + CONTEST_LIMITS.reminderLeadMs);
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.governanceContest.findMany({
            where: {
              openedAt: { not: null },
              remindedAt: null,
              closedAt: null,
              cancelledAt: null,
              closesAt: { gt: now, lte: until },
            },
            orderBy: [{ closesAt: 'asc' }, { id: 'asc' }],
            take: BATCH,
            select: { id: true },
          })
        ).map((c) => c.id),
      async (tx, _tenantId, id) => {
        const { count } = await tx.governanceContest.updateMany({
          where: {
            id,
            openedAt: { not: null },
            remindedAt: null,
            closedAt: null,
            cancelledAt: null,
            closesAt: { gt: now, lte: until },
          },
          data: { remindedAt: now },
        });
        if (!count) return 0;
        const contest = await tx.governanceContest.findUniqueOrThrow({
          where: { id },
        });
        const lead = contest.closesAt.getTime() - contest.openedAt!.getTime();
        if (lead < CONTEST_LIMITS.reminderLeadMs) return 0;
        const accounts = await tx.$queryRaw<{ account_id: string }[]>`
          SELECT e.account_id FROM governance_electors e
           WHERE e.contest_id = ${id}::uuid
             AND NOT EXISTS (SELECT 1 FROM governance_participations p
                              WHERE p.contest_id = e.contest_id AND p.unit_id = e.unit_id)
           ORDER BY e.account_id`;
        await this.handler(contest).remind(tx, contest, [
          ...new Set(accounts.map((a) => a.account_id)),
        ]);
        return 1;
      },
    );
  }

  openDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.governanceContest.findMany({
            where: { openedAt: null, cancelledAt: null, opensAt: { lte: now } },
            orderBy: [{ opensAt: 'asc' }, { id: 'asc' }],
            take: BATCH,
            select: { id: true },
          })
        ).map((c) => c.id),
      async (tx, _tenantId, id) => {
        const contest = await this.claim(tx, id);
        if (!contest || contest.openedAt || contest.opensAt > now) return 0;
        await this.handler(contest).open(tx, contest, now);
        return 1;
      },
    );
  }

  closeDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.governanceContest.findMany({
            where: {
              closedAt: null,
              cancelledAt: null,
              closesAt: { lte: now },
            },
            orderBy: [{ closesAt: 'asc' }, { id: 'asc' }],
            take: BATCH,
            select: { id: true },
          })
        ).map((c) => c.id),
      async (tx, _tenantId, id) => {
        let contest = await this.claim(tx, id);
        if (!contest || contest.closesAt > now) return 0;
        const handler = this.handler(contest);
        if (!contest.openedAt) {
          await handler.open(tx, contest, now);
          contest = await tx.governanceContest.findUniqueOrThrow({
            where: { id },
          });
          if (contest.cancelledAt) return 1;
        }
        await handler.close(tx, contest, now);
        return 1;
      },
    );
  }

  /** The contest locked for update unless another holds it; null when ended. */
  private async claim(
    tx: TenantTxClient,
    id: string,
  ): Promise<GovernanceContest | null> {
    const [claimed] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM governance_contests
       WHERE id = ${id}::uuid AND closed_at IS NULL AND cancelled_at IS NULL
         FOR UPDATE SKIP LOCKED`;
    if (!claimed) return null;
    return tx.governanceContest.findUniqueOrThrow({ where: { id } });
  }

  private handler(contest: GovernanceContest): ContestHandler {
    const handler = this.handlers.get(contest.kind);
    if (!handler) throw new Error(`No contest handler for ${contest.kind}`);
    return handler;
  }
}
