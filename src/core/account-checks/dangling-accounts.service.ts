import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import type { DanglingAccountFinding } from '@prisma/client';
import { StaffRecipients } from '../access/staff-recipients';
import { AccountLifecycle } from '../accounts/account-lifecycle';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../common/reasons';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Notifier } from '../notifications/notifier';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../staff-inbox/staff-inbox';
import { SweepRunner } from '../sweep/sweep-runner';
import {
  AccountChecks,
  CHECKED_TYPES,
  DAY_MS,
  KEEP_MUTE_DAYS,
  NEVER_SIGNED_IN_DAYS,
} from './account-checks';

export const DANGLING_SWEEP = 'accounts.dangling';
export const DANGLING_REASONS = [
  'idle',
  'vendor_suspended',
  'never_signed_in',
] as const;
export type DanglingReason = (typeof DANGLING_REASONS)[number];
export const FINDING_STATUSES = [
  'open',
  'kept',
  'deactivated',
  'cleared',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * A domain's rule: the active accounts it finds dangling now, in the
 * compound's transaction. Maintenance registers `vendor_suspended` (a
 * contractor whose vendor is suspended, ADR 0077, 0088): core imports no
 * domain.
 */
export type DanglingRule = (tx: TenantTxClient) => Promise<string[]>;

const LIST_MAX = 500;

export interface FindingRead {
  finding: DanglingAccountFinding;
  account: {
    id: string;
    fullName: string | null;
    status: string;
    type: string;
  };
  decidedBy: { id: string; fullName: string | null; status: string } | null;
}

const notFound = () =>
  appError.notFound(ErrorCode.DANGLING_ACCOUNT_NOT_FOUND, 'Finding not found');

/**
 * Dangling accounts (ADR 0090), on the compound's side only (staff,
 * manager, contractor): an active account that
 * - has not signed in, nor used a session, for the compound's idle days
 *   (60 by default, 14 to 365);
 * - nobody signed into within 14 days of its creation; or
 * - is a contractor whose vendor is suspended.
 *
 * The sweep (`accounts.dangling`, hourly) finds them and tells the
 * `accounts.manage` holders once (`dangling_account.found`); each is an
 * inbox item (`dangling_account`), decided once: kept with a code (muted
 * for 90 days), or deactivated in the deciding transaction. It is cleared
 * by the system when it no longer holds, or when the account leaves.
 * Nobody decides their own.
 *
 * Locks: the account's row first (FOR UPDATE to deactivate, FOR SHARE to
 * keep or to find), then the finding's; the one-open key is a partial
 * unique index behind the account's lock.
 */
@Injectable()
export class DanglingAccountsService
  implements OnModuleInit, OnApplicationBootstrap
{
  private readonly rules = new Map<DanglingReason, DanglingRule>();

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

  /** A domain's rule; `vendor_suspended` is maintenance's. */
  registerRule(reason: 'vendor_suspended', rule: DanglingRule): void {
    if (this.rules.has(reason))
      throw new Error(`Dangling rule ${reason} registered twice`);
    this.rules.set(reason, rule);
  }

  onApplicationBootstrap(): void {
    if (!this.rules.has('vendor_suspended'))
      throw new Error('Dangling rule vendor_suspended missing');
  }

  onModuleInit(): void {
    this.sweep.register(DANGLING_SWEEP, (now) => this.run(now));
    // Leaving clears the open finding: nothing is left to decide.
    const left = async (tx: TenantTxClient, account: { id: string }) => {
      await this.clear(tx, account.id, 'left');
      return [];
    };
    this.lifecycle.onDeactivated(left);
    this.lifecycle.onErasing(left);
    this.inbox.register({
      type: 'dangling_account',
      permission: 'accounts.manage',
      dueHours: 168,
      page: async (tx, q) => {
        const rows = await tx.danglingAccountFinding.findMany({
          where: {
            AND: [
              { status: 'open' },
              ...waitingSince('foundAt', q.requestedBefore),
              ...afterCursor('foundAt', q.after),
            ],
          },
          orderBy: [{ foundAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, reason: true, status: true, foundAt: true },
        });
        return rows.map((r) => ({
          type: 'dangling_account' as const,
          id: r.id,
          number: null,
          kind: r.reason,
          status: r.status,
          unitId: null,
          requestedAt: r.foundAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.danglingAccountFinding.count({
          where: {
            AND: [{ status: 'open' }, ...waitingSince('foundAt', before)],
          },
        }),
    });
  }

  list(q: { status?: FindingStatus }): Promise<FindingRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.danglingAccountFinding.findMany({
        where: q.status ? { status: q.status } : {},
        orderBy: [{ foundAt: 'desc' }, { id: 'desc' }],
        take: LIST_MAX,
      });
      return this.reads(tx, rows);
    });
  }

  get(id: string): Promise<FindingRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.danglingAccountFinding.findUnique({ where: { id } });
      if (!row) throw notFound();
      return (await this.reads(tx, [row]))[0];
    });
  }

  /** Kept with a code: muted for 90 days. */
  keep(id: string, reasonCode?: string): Promise<FindingRead> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.danglingKeep);
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await this.decidable(tx, id, 'share');
      const now = await this.dbNow(tx);
      const mutedUntil = new Date(now.getTime() + KEEP_MUTE_DAYS * DAY_MS);
      const kept = await tx.danglingAccountFinding.update({
        where: { id },
        data: {
          status: 'kept',
          decidedAt: now,
          decidedById: this.ctx.accountId,
          reasonCode: code,
          mutedUntil,
        },
      });
      await this.audit.record(tx, {
        action: 'dangling_account.kept',
        targetId: row.accountId,
        metadata: {
          findingId: id,
          reasonCode: code,
          mutedUntil: mutedUntil.toISOString(),
        },
      });
      return (await this.reads(tx, [kept]))[0];
    });
  }

  /** Deactivated in the deciding transaction, as a status change is. */
  async deactivate(id: string): Promise<FindingRead> {
    const { read, change } = await this.tenantTx.withTenantTx(async (tx) => {
      const row = await this.decidable(tx, id, 'update');
      const decided = await tx.danglingAccountFinding.update({
        where: { id },
        data: {
          status: 'deactivated',
          decidedAt: await this.dbNow(tx),
          decidedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'dangling_account.deactivated',
        targetId: row.accountId,
        metadata: { findingId: id },
      });
      const change = await this.checks.deactivate(tx, row.accountId);
      return { read: (await this.reads(tx, [decided]))[0], change };
    });
    await this.checks.afterDeactivation(change);
    return read;
  }

  /**
   * The sweep: what is found dangling now, each told once; what no longer
   * holds, cleared. Each account in a transaction of its own, under its
   * row; judged again there.
   */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true },
        });
        if (tenant?.status !== 'active') return [];
        const found = await this.findAll(tx, tenantId, now);
        const open = await tx.danglingAccountFinding.findMany({
          where: { status: 'open' },
          select: { accountId: true },
        });
        const ids = new Set([...found.keys(), ...open.map((o) => o.accountId)]);
        return [...ids].sort();
      },
      async (tx, tenantId, accountId) => {
        const account = await this.checks.lockAccount(tx, accountId, 'share');
        const reason =
          account?.status === 'active'
            ? ((await this.findAll(tx, tenantId, now, [accountId])).get(
                accountId,
              ) ?? null)
            : null;
        const open = await tx.danglingAccountFinding.findFirst({
          where: { accountId, status: 'open' },
        });
        if (open && !reason) {
          await this.clear(tx, accountId, 'active_again');
          return 0;
        }
        if (open || !reason) return 0;
        return this.open(tx, tenantId, accountId, reason, now);
      },
    );
  }

  // --------------------------------------------------------------------------

  /**
   * The active accounts of the compound's side dangling now, with the
   * reason (a vendor's suspension first, then never signed into, then
   * idle), but those with an open finding or muted by a kept one.
   */
  private async findAll(
    tx: TenantTxClient,
    tenantId: string,
    now: Date,
    only?: string[],
  ): Promise<Map<string, DanglingReason>> {
    const { idleDays } = await this.checks.settings(tx);
    const muted = new Set(
      (
        await tx.danglingAccountFinding.findMany({
          where: { status: 'kept', mutedUntil: { gt: now } },
          select: { accountId: true },
        })
      ).map((r) => r.accountId),
    );
    const accounts = await tx.account.findMany({
      where: {
        status: 'active',
        type: { in: [...CHECKED_TYPES] },
        ...(only ? { id: { in: only } } : {}),
      },
      select: { id: true, createdAt: true },
      orderBy: { id: 'asc' },
    });
    const candidates = accounts.filter((a) => !muted.has(a.id));
    const out = new Map<string, DanglingReason>();
    const suspended = new Set(
      await (this.rules.get('vendor_suspended')?.(tx) ?? Promise.resolve([])),
    );
    const last = await this.checks.lastActive(
      tx,
      tenantId,
      candidates.map((a) => a.id),
    );
    const idleBefore = now.getTime() - idleDays * DAY_MS;
    const newBefore = now.getTime() - NEVER_SIGNED_IN_DAYS * DAY_MS;
    for (const a of candidates) {
      const seen = last.get(a.id);
      if (suspended.has(a.id)) out.set(a.id, 'vendor_suspended');
      else if (!seen && a.createdAt.getTime() < newBefore)
        out.set(a.id, 'never_signed_in');
      else if (seen && seen.getTime() < idleBefore) out.set(a.id, 'idle');
    }
    return out;
  }

  private async open(
    tx: TenantTxClient,
    tenantId: string,
    accountId: string,
    reason: DanglingReason,
    now: Date,
  ): Promise<number> {
    const id = newId();
    const lastActiveAt =
      (await this.checks.lastActive(tx, tenantId, [accountId])).get(
        accountId,
      ) ?? null;
    await tx.danglingAccountFinding.create({
      data: {
        id,
        tenantId,
        accountId,
        reason,
        lastActiveAt,
        foundAt: now,
      },
    });
    await this.audit.record(tx, {
      action: 'dangling_account.found',
      targetId: accountId,
      metadata: { findingId: id, reason },
    });
    const to = (await this.staff.holding(tx, 'accounts.manage'))
      .map((r) => r.id)
      .filter((r) => r !== accountId);
    if (to.length)
      await this.notifier.notify(tx, to, {
        kind: 'dangling_account.found',
        params: { reason },
        targetId: id,
      });
    return 1;
  }

  /** The account's open finding cleared by the system, if any. */
  private async clear(
    tx: TenantTxClient,
    accountId: string,
    why: 'active_again' | 'left',
  ): Promise<void> {
    const [open] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM dangling_account_findings
       WHERE account_id = ${accountId}::uuid AND status = 'open'
       FOR UPDATE`;
    if (!open) return;
    await tx.danglingAccountFinding.update({
      where: { id: open.id },
      data: { status: 'cleared', clearedAt: await this.dbNow(tx) },
    });
    await this.audit.record(tx, {
      action: 'dangling_account.cleared',
      targetId: accountId,
      metadata: { findingId: open.id, why },
    });
  }

  /** An open finding, its account locked first; never the caller's own. */
  private async decidable(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<DanglingAccountFinding> {
    const found = await tx.danglingAccountFinding.findUnique({
      where: { id },
      select: { accountId: true },
    });
    if (!found) throw notFound();
    if (found.accountId === this.ctx.accountId)
      throw appError.conflict(
        ErrorCode.CANNOT_CHANGE_OWN_STATUS,
        'Someone else decides your own account',
      );
    await this.checks.lockAccount(tx, found.accountId, mode);
    await tx.$queryRaw`SELECT id FROM dangling_account_findings WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.danglingAccountFinding.findUniqueOrThrow({
      where: { id },
    });
    if (row.status !== 'open')
      throw appError.conflict(
        ErrorCode.DANGLING_ACCOUNT_DECIDED,
        'This finding was decided already',
        { params: { status: row.status } },
      );
    return row;
  }

  private async dbNow(tx: TenantTxClient): Promise<Date> {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
      SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    return now;
  }

  private async reads(
    tx: TenantTxClient,
    rows: readonly DanglingAccountFinding[],
  ): Promise<FindingRead[]> {
    const ids = [
      ...new Set(
        rows.flatMap((r) =>
          [r.accountId, r.decidedById].filter((x): x is string => x !== null),
        ),
      ),
    ];
    const people = new Map(
      (ids.length
        ? await tx.account.findMany({
            where: { id: { in: ids } },
            select: { id: true, fullName: true, status: true, type: true },
          })
        : []
      ).map((a) => [a.id, a]),
    );
    return rows.map((r) => ({
      finding: r,
      account: people.get(r.accountId) ?? {
        id: r.accountId,
        fullName: null,
        status: 'erased',
        type: 'staff',
      },
      decidedBy: r.decidedById ? (people.get(r.decidedById) ?? null) : null,
    }));
  }
}
