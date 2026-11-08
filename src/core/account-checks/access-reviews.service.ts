import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AccessReview, AccessReviewLine } from '@prisma/client';
import { StaffRecipients } from '../access/staff-recipients';
import { AccountLifecycle } from '../accounts/account-lifecycle';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Notifier } from '../notifications/notifier';
import {
  afterCursor,
  reference,
  StaffInbox,
  waitingSince,
} from '../staff-inbox/staff-inbox';
import { SweepRunner } from '../sweep/sweep-runner';
import {
  AccountChecks,
  CHECKED_TYPES,
  DAY_MS,
  type AccountCheckSettingsRead,
} from './account-checks';

export const ACCESS_REVIEW_SWEEP = 'accounts.access_review';
/** The system role whose line is kept only (ADR 0010's lockout rule). */
export const PROTECTED_ROLE_KEY = 'manager';
const LIST_MAX = 100;

export type LineDecision = 'keep' | 'revoke';

export interface ReviewRead {
  review: AccessReview;
  openedBy: Person | null;
}

type Person = { id: string; fullName: string | null; status: string };

export interface LineRead {
  line: AccessReviewLine;
  account: Person;
  decidedBy: Person | null;
}

export interface ReviewDetail extends ReviewRead {
  lines: LineRead[];
}

const notFound = () =>
  appError.notFound(
    ErrorCode.ACCESS_REVIEW_NOT_FOUND,
    'Access review not found',
  );
const lineNotFound = () =>
  appError.notFound(ErrorCode.ACCESS_REVIEW_LINE_NOT_FOUND, 'Line not found');

/**
 * Access reviews (ADR 0090): who has access, reviewed every so often.
 *
 * - **Opened** by the sweep (`accounts.access_review`, hourly) once the
 *   compound's cadence has passed since the last one opened (90 days by
 *   default, 30 to 365; the first that long after the compound was made),
 *   or by an `accounts.manage` holder at any time; one open at a time,
 *   under the compound's review lock.
 * - **A frozen snapshot**: every active account of the compound's side
 *   (staff, manager, contractor) as it was then — its role and the
 *   role's permissions, its last sign-in. An account made after waits for
 *   the next review.
 * - **Each line decided once** by an `accounts.manage` holder, never its
 *   own: kept, or revoked — the account is deactivated in the same
 *   transaction. The system manager's line is kept only. A line whose
 *   account left first is marked `left` by the system.
 * - **Closed** once every line is decided. It is the staff inbox's item
 *   `access_review` while open (due in 14 days, the inbox's overdue
 *   notice once).
 *
 * Locks: the line's account (FOR UPDATE to revoke, FOR SHARE to keep) —
 * the order a deactivation takes it, before its hooks reach the review —
 * then the review FOR UPDATE, then the line.
 */
@Injectable()
export class AccessReviewsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly lifecycle: AccountLifecycle,
    private readonly inbox: StaffInbox,
    private readonly checks: AccountChecks,
  ) {}

  onModuleInit(): void {
    this.sweep.register(ACCESS_REVIEW_SWEEP, (now) => this.run(now));
    const left = async (tx: TenantTxClient, account: { id: string }) => {
      await this.left(tx, account.id);
      return [];
    };
    this.lifecycle.onDeactivated(left);
    this.lifecycle.onErasing(left);
    this.inbox.register({
      type: 'access_review',
      permission: 'accounts.manage',
      dueHours: 14 * 24,
      page: async (tx, q) => {
        const rows = await tx.accessReview.findMany({
          where: {
            AND: [
              { status: 'open' },
              ...waitingSince('openedAt', q.requestedBefore),
              ...afterCursor('openedAt', q.after),
            ],
          },
          orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, number: true, status: true, openedAt: true },
        });
        return rows.map((r) => ({
          type: 'access_review' as const,
          id: r.id,
          number: reference('AR', r.number),
          kind: null,
          status: r.status,
          unitId: null,
          requestedAt: r.openedAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.accessReview.count({
          where: {
            AND: [{ status: 'open' }, ...waitingSince('openedAt', before)],
          },
        }),
    });
  }

  // --- settings, shared with the dangling accounts ---------------------------

  settings(): Promise<AccountCheckSettingsRead> {
    return this.tenantTx.withTenantTx((tx) => this.checks.settings(tx));
  }

  /** The row is made by the first change, under the compound's lock. */
  updateSettings(
    patch: Partial<AccountCheckSettingsRead>,
  ): Promise<AccountCheckSettingsRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`account-checks:${tenantId}`}))`;
      const before = await this.checks.settings(tx);
      const next = { ...before, ...patch };
      await tx.accountCheckSettings.upsert({
        where: { tenantId },
        create: {
          tenantId,
          idleDays: next.idleDays,
          reviewEveryDays: next.reviewEveryDays,
          updatedById: this.ctx.accountId,
        },
        update: {
          idleDays: next.idleDays,
          reviewEveryDays: next.reviewEveryDays,
          updatedById: this.ctx.accountId,
          updatedAt: new Date(),
        },
      });
      const changes = diffChanges(
        { ...before },
        { ...next },
        'access_review.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'access_review.settings_changed',
          targetId: tenantId,
          changes,
        });
      return next;
    });
  }

  // --- reviews ----------------------------------------------------------------

  list(): Promise<ReviewRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.accessReview.findMany({
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: LIST_MAX,
      });
      const people = await this.people(
        tx,
        rows.map((r) => r.openedById),
      );
      return rows.map((r) => ({
        review: r,
        openedBy: r.openedById ? (people.get(r.openedById) ?? null) : null,
      }));
    });
  }

  get(id: string): Promise<ReviewDetail> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const review = await tx.accessReview.findUnique({ where: { id } });
      if (!review) throw notFound();
      return this.detail(tx, review);
    });
  }

  /** Opened now by a keeper: one open at a time (ACCESS_REVIEW_OPEN). */
  openNow(): Promise<ReviewDetail> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const review = await this.open(
        tx,
        this.ctx.txTenantId,
        this.ctx.accountId,
      );
      if (!review)
        throw appError.conflict(
          ErrorCode.ACCESS_REVIEW_OPEN,
          'An access review is open already',
        );
      return this.detail(tx, review);
    });
  }

  /**
   * A line kept or revoked, once, never by its own account; a revoked one's
   * account deactivated in the same transaction. The review closes with
   * its last line.
   */
  async decide(
    reviewId: string,
    lineId: string,
    decision: LineDecision,
  ): Promise<ReviewDetail> {
    const { detail, change } = await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.accessReviewLine.findFirst({
        where: { id: lineId, reviewId },
        select: { accountId: true },
      });
      if (!found) throw lineNotFound();
      if (found.accountId === this.ctx.accountId)
        throw appError.forbidden(
          ErrorCode.ACCESS_REVIEW_OWN_LINE,
          'Someone else decides your own line',
        );
      await this.checks.lockAccount(
        tx,
        found.accountId,
        decision === 'revoke' ? 'update' : 'share',
      );
      const review = await this.lockReview(tx, reviewId);
      if (!review) throw notFound();
      if (review.status !== 'open')
        throw appError.conflict(
          ErrorCode.ACCESS_REVIEW_CLOSED,
          'This access review is closed',
        );
      await tx.$queryRaw`SELECT id FROM access_review_lines WHERE id = ${lineId}::uuid FOR UPDATE`;
      const line = await tx.accessReviewLine.findUniqueOrThrow({
        where: { id: lineId },
      });
      if (line.decision)
        throw appError.conflict(
          ErrorCode.ACCESS_REVIEW_LINE_DECIDED,
          'This line was decided already',
          { params: { decision: line.decision } },
        );
      if (line.protected && decision === 'revoke')
        throw appError.conflict(
          ErrorCode.ACCESS_REVIEW_LINE_PROTECTED,
          'The manager’s account is kept',
        );
      const now = await this.dbNow(tx);
      await tx.accessReviewLine.update({
        where: { id: lineId },
        data: { decision, decidedAt: now, decidedById: this.ctx.accountId },
      });
      const after = await tx.accessReview.update({
        where: { id: reviewId },
        data:
          decision === 'keep'
            ? { kept: { increment: 1 } }
            : { revoked: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'access_review.line_decided',
        targetId: reviewId,
        metadata: { lineId, accountId: line.accountId, decision },
      });
      // The account goes after its line: its hooks find nothing to mark.
      const change =
        decision === 'revoke'
          ? await this.checks.deactivate(tx, line.accountId)
          : null;
      const closed = await this.closeIfDone(tx, after, now);
      return { detail: await this.detail(tx, closed), change };
    });
    await this.checks.afterDeactivation(change);
    return detail;
  }

  /** Every compound whose cadence has passed: one review opened. */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true, createdAt: true },
        });
        if (tenant?.status !== 'active') return [];
        return (await this.due(tx, tenant.createdAt, now)) ? [tenantId] : [];
      },
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { createdAt: true },
        });
        // Judged again under the compound's review lock, inside open().
        if (!(await this.due(tx, tenant.createdAt, now))) return 0;
        return (await this.open(tx, tenantId, null)) ? 1 : 0;
      },
    );
  }

  // --------------------------------------------------------------------------

  /** None open, and the cadence passed since the last one (or the compound's start). */
  private async due(
    tx: TenantTxClient,
    tenantCreatedAt: Date,
    now: Date,
  ): Promise<boolean> {
    const open = await tx.accessReview.count({ where: { status: 'open' } });
    if (open) return false;
    const last = await tx.accessReview.findFirst({
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      select: { openedAt: true },
    });
    const { reviewEveryDays } = await this.checks.settings(tx);
    const since = last?.openedAt ?? tenantCreatedAt;
    return now.getTime() - since.getTime() >= reviewEveryDays * DAY_MS;
  }

  /**
   * One review, its snapshot taken now, under the compound's review lock;
   * null when one is open already. `by` null: the system.
   */
  private async open(
    tx: TenantTxClient,
    tenantId: string,
    by: string | null,
  ): Promise<AccessReview | null> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`access-review:${tenantId}`}))`;
    if (await tx.accessReview.count({ where: { status: 'open' } })) return null;
    const accounts = await tx.account.findMany({
      where: { status: 'active', type: { in: [...CHECKED_TYPES] } },
      select: {
        id: true,
        type: true,
        role: {
          select: {
            id: true,
            key: true,
            name: true,
            permissions: { select: { permission: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    const last = await this.checks.lastActive(
      tx,
      tenantId,
      accounts.map((a) => a.id),
    );
    const [{ max }] = await tx.$queryRaw<{ max: number | null }[]>`
      SELECT max(number) AS max FROM access_reviews`;
    const now = await this.dbNow(tx);
    const id = newId();
    const review = await tx.accessReview.create({
      data: {
        id,
        tenantId,
        number: (max ?? 0) + 1,
        openedAt: now,
        openedById: by,
        lines: accounts.length,
      },
    });
    if (accounts.length)
      await tx.accessReviewLine.createMany({
        data: accounts.map((a) => ({
          id: newId(),
          tenantId,
          reviewId: id,
          accountId: a.id,
          accountType: a.type,
          roleId: a.role.id,
          roleKey: a.role.key,
          roleName: a.role.name,
          permissions: a.role.permissions.map((p) => p.permission).sort(),
          lastActiveAt: last.get(a.id) ?? null,
          protected: a.role.key === PROTECTED_ROLE_KEY,
        })),
      });
    await this.audit.record(tx, {
      action: 'access_review.opened',
      targetId: id,
      metadata: { lines: accounts.length, by: by ? 'staff' : 'system' },
    });
    const to = (await this.staff.holding(tx, 'accounts.manage')).map(
      (r) => r.id,
    );
    if (to.length)
      await this.notifier.notify(tx, to, {
        kind: 'access_review.opened',
        params: { lines: accounts.length },
        targetId: id,
      });
    // A compound with nobody to review closes at once.
    return this.closeIfDone(tx, review, now);
  }

  /** The account left: its undecided lines marked `left` by the system. */
  private async left(tx: TenantTxClient, accountId: string): Promise<void> {
    const lines = await tx.accessReviewLine.findMany({
      where: { accountId, decision: null },
      select: { id: true, reviewId: true },
      orderBy: { reviewId: 'asc' },
    });
    for (const l of lines) {
      const review = await this.lockReview(tx, l.reviewId);
      if (!review || review.status !== 'open') continue;
      const now = await this.dbNow(tx);
      await tx.accessReviewLine.update({
        where: { id: l.id },
        data: { decision: 'left', decidedAt: now },
      });
      const after = await tx.accessReview.update({
        where: { id: l.reviewId },
        data: { leftCount: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'access_review.line_decided',
        targetId: l.reviewId,
        metadata: { lineId: l.id, accountId, decision: 'left' },
      });
      await this.closeIfDone(tx, after, now);
    }
  }

  private async closeIfDone(
    tx: TenantTxClient,
    review: AccessReview,
    now: Date,
  ): Promise<AccessReview> {
    if (
      review.status !== 'open' ||
      review.kept + review.revoked + review.leftCount < review.lines
    )
      return review;
    const closed = await tx.accessReview.update({
      where: { id: review.id },
      data: { status: 'closed', closedAt: now },
    });
    await this.audit.record(tx, {
      action: 'access_review.closed',
      targetId: review.id,
      metadata: {
        kept: closed.kept,
        revoked: closed.revoked,
        left: closed.leftCount,
      },
    });
    return closed;
  }

  private async lockReview(
    tx: TenantTxClient,
    id: string,
  ): Promise<AccessReview | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM access_reviews WHERE id = ${id}::uuid FOR UPDATE`;
    return row ? tx.accessReview.findUniqueOrThrow({ where: { id } }) : null;
  }

  private async detail(
    tx: TenantTxClient,
    review: AccessReview,
  ): Promise<ReviewDetail> {
    const lines = await tx.accessReviewLine.findMany({
      where: { reviewId: review.id },
      orderBy: [{ accountType: 'asc' }, { id: 'asc' }],
    });
    const people = await this.people(tx, [
      review.openedById,
      ...lines.flatMap((l) => [l.accountId, l.decidedById]),
    ]);
    const person = (id: string): Person =>
      people.get(id) ?? { id, fullName: null, status: 'erased' };
    return {
      review,
      openedBy: review.openedById ? person(review.openedById) : null,
      lines: lines.map((l) => ({
        line: l,
        account: person(l.accountId),
        decidedBy: l.decidedById ? person(l.decidedById) : null,
      })),
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

  private async dbNow(tx: TenantTxClient): Promise<Date> {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
      SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    return now;
  }
}
