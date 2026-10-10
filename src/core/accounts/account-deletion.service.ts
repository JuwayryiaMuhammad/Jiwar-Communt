import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { StaffRecipients } from '../access/staff-recipients';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import type { AppClsStore } from '../common/cls/app-cls';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  requireReasonCodeOnly,
  type ReasonInput,
} from '../common/reasons';
import { newId } from '../common/uuid';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { NO_RECIPIENT, Outbox } from '../mail/outbox';
import { Notifier } from '../notifications/notifier';
import { SweepRunner } from '../sweep/sweep-runner';
import { ACCOUNT_EMAILS } from './account-emails';
import {
  AccountLifecycle,
  runAfterCommit,
  type AfterCommit,
} from './account-lifecycle';

/** Reminders two days before, then executions (ADR 0036). */
export const DELETION_SWEEP = 'accounts.deletion';

/** The account is reminded this long before its erasure. */
export const DELETION_REMINDER_MS = 2 * 86_400_000;

/** Queued first, then the most overdue: the oldest end of grace. */
const ERASURE_PAGE = keysetCursor('effectiveAt', 'asc');

/** The words the holder types to confirm (02 §4), per language. */
export const CONFIRMATION_WORDS = ['حذف', 'DELETE'] as const;

/**
 * What keeps an account from being erased (ADR 0036), checked when the
 * deletion is asked for and again in the transaction that executes it:
 * - `primary_resident`: the primary of a unit must hand it over (ADR 0021)
 *   or end the occupancy first (the community domain);
 * - `active_staff_role`: an active staff or manager account (roles never
 *   cross account kinds, ADR 0010);
 * - `legal_hold`: an obligation to keep the data (ADR 0023);
 * - `open_worker_obligations`: a worker's wage not yet settled, which an
 *   erasure would leave without its employer (ADR 0022; the community).
 */
export const DELETION_BLOCKERS = [
  'primary_resident',
  'active_staff_role',
  'legal_hold',
  'open_worker_obligations',
] as const;

type RequestStatus =
  'pending' | 'cancelled' | 'completed' | 'queued' | 'closed';

export interface DeletionRequestView {
  id: string;
  status: RequestStatus;
  requestedAt: Date;
  /** Undo is possible until then; the erasure runs after it. */
  effectiveAt: Date;
  /** Filed by the management for the account (ADR 0036). */
  assisted: boolean;
  /** Queued: what blocked the erasure. */
  blockers: string[];
}

export interface PendingErasure extends DeletionRequestView {
  accountId: string;
  /** Days since the grace period ended (negative: still in grace). */
  daysOverdue: number;
  onLegalHold: boolean;
}

/** Step 1 of 3 (09 §4): what goes and what stays, and the phrase to type. */
export interface ErasureScope {
  requestId: string;
  accountId: string;
  /** Step 3 must type exactly this. */
  scopePhrase: string;
  erased: {
    personalFields: readonly string[];
    activeOccupancies: number;
    activeMemberships: number;
    workerEngagementsRequested: number;
    sessions: number;
    pendingMessages: number;
    invitesAccepted: number;
  };
  kept: {
    auditEntries: number;
    note: string;
  };
}

export interface LegalHoldView {
  id: string;
  accountId: string;
  reasonCode: string;
  placedAt: Date;
}

const PERSONAL_FIELDS = [
  'fullName',
  'phone',
  'email',
  'idDocumentType',
  'idDocumentNumber',
  'nationality',
  'birthDate',
] as const;

/**
 * Account deletion (ADR 0023, amended by ADR 0036; 02 §4, 09 §4–5).
 *
 * - The holder asks with a confirmation word, or a manager asks for it
 *   (assisted). It is refused while something blocks the erasure
 *   (DELETION_BLOCKERS, DELETION_BLOCKED). The account is told, and keeps
 *   working normally through the cooling-off (DELETION_GRACE_DAYS, 14),
 *   when it can still cancel.
 * - The sweep (`accounts.deletion`) reminds the account two days before,
 *   then, once the cooling-off is over, re-checks the blockers inside the
 *   transaction that executes it, under the account's row lock: with none
 *   it erases the account; with some it queues the request for the
 *   managers with its blocker codes, and tells the account and the
 *   `accounts.erase` holders.
 * - Managers list pending and queued requests and act on queued ones:
 *   execute (the three steps: scope → legal hold → typed scope, blockers
 *   re-checked) once the blockers are cleared, or close with a reason code.
 * - Erasure makes a TOMBSTONE: the row stays with every personal field
 *   NULL, so audit and financial records keep their pointer and show a
 *   deleted user. Login identifiers and sessions are deleted, pending mail
 *   to that account is stripped, invites that brought them in lose their
 *   personal data, and the domains end what hangs off the account
 *   (AccountLifecycle.onErasing). The audit log is never touched.
 */
@Injectable()
export class AccountDeletionService implements OnModuleInit {
  private readonly logger = new Logger(AccountDeletionService.name);
  private readonly graceMs: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly audit: AuditService,
    private readonly outbox: Outbox,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly lifecycle: AccountLifecycle,
    private readonly sweep: SweepRunner,
  ) {
    this.graceMs =
      config.get('DELETION_GRACE_DAYS', { infer: true }) * 86_400_000;
  }

  onModuleInit(): void {
    this.sweep.register(DELETION_SWEEP, (now) => this.runDue(now));
    // Core's own blockers; the domains register theirs.
    this.lifecycle.onDeletionCheck(async (tx, account) => {
      const codes: string[] = [];
      const row = await tx.account.findUniqueOrThrow({
        where: { id: account.id },
        select: { type: true, status: true },
      });
      if (
        (row.type === 'staff' || row.type === 'manager') &&
        row.status === 'active'
      )
        codes.push('active_staff_role');
      const holds = await tx.legalHold.count({
        where: { accountId: account.id, releasedAt: null },
      });
      if (holds) codes.push('legal_hold');
      return codes;
    });
  }

  // --------------------------------------------------------------------------
  // The holder
  // --------------------------------------------------------------------------

  async requestDeletion(
    confirmation: string,
    now: Date = new Date(),
  ): Promise<DeletionRequestView> {
    const word = (confirmation ?? '').trim();
    if (
      !CONFIRMATION_WORDS.some((w) => w.toLowerCase() === word.toLowerCase())
    ) {
      throw appError.badRequest(
        ErrorCode.CONFIRMATION_MISMATCH,
        'Type the confirmation word to delete your account',
        { params: { expected: [...CONFIRMATION_WORDS] } },
      );
    }
    return this.tenantTx.withTenantTx((tx) =>
      this.fileRequest(tx, this.ctx.accountId, null, now),
    );
  }

  /**
   * Files a request in the caller's transaction, for the account itself or
   * on its behalf (`assist`), under the account's row lock: refused while
   * one is open, and while anything blocks the erasure.
   */
  async fileRequest(
    tx: TenantTxClient,
    accountId: string,
    assist: { reasonCode: string } | null,
    now: Date,
  ): Promise<DeletionRequestView> {
    const account = await this.lockAccount(tx, accountId);
    if (account.status === 'erased') throw accountNotFound();
    const open = await tx.accountDeletionRequest.count({
      where: { accountId, status: { in: ['pending', 'queued'] } },
    });
    if (open) {
      throw appError.conflict(
        ErrorCode.DELETION_ALREADY_REQUESTED,
        'A deletion is already pending',
      );
    }
    const blockers = await this.blockers(tx, account);
    if (blockers.length) throw deletionBlocked(blockers);
    const request = await tx.accountDeletionRequest.create({
      data: {
        id: newId(),
        tenantId: account.tenantId,
        accountId,
        requestedAt: now,
        effectiveAt: new Date(now.getTime() + this.graceMs),
        requestedById: this.ctx.accountId,
        assisted: !!assist,
        assistReasonCode: assist?.reasonCode ?? null,
      },
    });
    await this.audit.record(tx, {
      action: 'account.deletion_requested',
      targetId: accountId,
      metadata: {
        requestId: request.id,
        effectiveAt: request.effectiveAt,
        assisted: !!assist,
        ...(assist ? { reasonCode: assist.reasonCode } : {}),
      },
    });
    // Critical (ADR 0036): never muted or held.
    await this.notifier.notify(tx, [accountId], {
      kind: 'account.deletion_requested',
      params: { effectiveAt: request.effectiveAt.toISOString() },
      targetId: request.id,
    });
    await this.tell(tx, accountId, ACCOUNT_EMAILS.deletionRequested, {
      effectiveDate: request.effectiveAt.toISOString().slice(0, 10),
    });
    return view(request);
  }

  /**
   * Undo: while the cooling-off lasts, or once queued (it has not run).
   * Under the account's row lock, like the execution, so the two never
   * cross: whichever is second finds the other's result.
   */
  async cancelDeletion(now: Date = new Date()): Promise<void> {
    await this.tenantTx.withTenantTx((tx) =>
      this.cancelIn(tx, this.ctx.accountId, null, now),
    );
  }

  async cancelIn(
    tx: TenantTxClient,
    accountId: string,
    assist: { reasonCode: string } | null,
    now: Date,
  ): Promise<void> {
    await this.lockAccount(tx, accountId);
    const request = await tx.accountDeletionRequest.findFirst({
      where: { accountId, status: { in: ['pending', 'queued'] } },
    });
    if (!request) throw requestNotFound();
    if (request.status === 'pending' && request.effectiveAt <= now) {
      throw appError.conflict(
        ErrorCode.DELETION_GRACE_OVER,
        'The grace period has ended',
      );
    }
    await tx.accountDeletionRequest.update({
      where: { id: request.id },
      data: { status: 'cancelled', cancelledAt: now },
    });
    await this.audit.record(tx, {
      action: 'account.deletion_cancelled',
      targetId: accountId,
      changes: diffChanges(
        { status: request.status },
        { status: 'cancelled' },
        'account.deletion_cancelled',
      ),
      metadata: {
        requestId: request.id,
        assisted: !!assist,
        ...(assist ? { reasonCode: assist.reasonCode } : {}),
      },
    });
    await this.tell(tx, accountId, ACCOUNT_EMAILS.deletionCancelled, {});
  }

  async myDeletionRequest(): Promise<DeletionRequestView | null> {
    return this.tenantTx.withTenantTx((tx) =>
      this.latestRequest(tx, this.ctx.accountId),
    );
  }

  /** The account's latest request, whatever its status, or null. */
  async latestRequest(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<DeletionRequestView | null> {
    const request = await tx.accountDeletionRequest.findFirst({
      where: { accountId },
      orderBy: { requestedAt: 'desc' },
    });
    return request ? view(request) : null;
  }

  /** What blocks the account's erasure now (core and the domains). */
  async blockers(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<string[]> {
    const codes = new Set(await this.lifecycle.deletionBlockers(tx, account));
    return DELETION_BLOCKERS.filter((c) => codes.has(c));
  }

  // --------------------------------------------------------------------------
  // Staff (`accounts.erase`, `accounts.legal_hold`)
  // --------------------------------------------------------------------------

  /**
   * Open requests (pending and queued), most overdue first (oldest
   * `effectiveAt`), a page at a time, with their age, blockers and hold.
   */
  async pendingErasures(
    q: { cursor?: string; limit?: number } = {},
    now: Date = new Date(),
  ): Promise<Page<PendingErasure>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.accountDeletionRequest.findMany({
        where: {
          AND: [
            { status: { in: ['pending', 'queued'] } },
            ...(ERASURE_PAGE.after(
              q.cursor,
            ) as Prisma.AccountDeletionRequestWhereInput[]),
          ],
        },
        orderBy: ERASURE_PAGE.orderBy,
        include: {
          account: { select: { legalHolds: { where: { releasedAt: null } } } },
        },
        take: limit + 1,
      });
      const page = ERASURE_PAGE.toPage(rows, limit);
      return {
        items: page.items.map((r) => ({
          ...view(r),
          accountId: r.accountId,
          daysOverdue: Math.floor(
            (now.getTime() - r.effectiveAt.getTime()) / 86_400_000,
          ),
          onLegalHold: r.account.legalHolds.length > 0,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** Step 1: the scope, and the phrase step 3 must type. */
  async erasureScope(requestId: string): Promise<ErasureScope> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const request = await tx.accountDeletionRequest.findFirst({
        where: { id: requestId, status: { in: ['pending', 'queued'] } },
      });
      if (!request) throw requestNotFound();
      const accountId = request.accountId;
      const global = this.globalDb.in(tx);
      const occupancies = await tx.unitOccupancy.count({
        where: { accountId, status: 'active' },
      });
      const memberships = await tx.householdMember.count({
        where: { accountId, status: { in: ['active', 'pending_approval'] } },
      });
      const engagements = await tx.workerEngagement.count({
        where: {
          requestedById: accountId,
          status: { in: ['pending_review', 'active', 'suspended'] },
        },
      });
      const sessions = await global.session.count({ where: { accountId } });
      const messages = await global.outboxMessage.count({
        where: {
          recipientAccountId: accountId,
          status: { in: ['pending', 'processing', 'held'] },
        },
      });
      const invites = await tx.householdInvite.count({
        where: { acceptedAccountId: accountId, strippedAt: null },
      });
      const audit = await tx.auditLog.count({
        where: { OR: [{ actorId: accountId }, { targetId: accountId }] },
      });
      return {
        requestId,
        accountId,
        scopePhrase: scopePhrase(accountId),
        erased: {
          personalFields: PERSONAL_FIELDS,
          activeOccupancies: occupancies,
          activeMemberships: memberships,
          workerEngagementsRequested: engagements,
          sessions,
          pendingMessages: messages,
          invitesAccepted: invites,
        },
        kept: {
          auditEntries: audit,
          note: 'Audit and financial records stay, pointing at a deleted user.',
        },
      };
    });
  }

  /** Step 2: any legal obligation to keep the data blocks erasure. */
  async activeHolds(accountId: string): Promise<LegalHoldView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true },
      });
      if (!account) throw accountNotFound();
      const rows = await tx.legalHold.findMany({
        where: { accountId, releasedAt: null },
      });
      return rows.map((h) => ({
        id: h.id,
        accountId: h.accountId,
        reasonCode: h.reasonCode,
        placedAt: h.placedAt,
      }));
    });
  }

  async placeLegalHold(
    accountId: string,
    reasonInput: ReasonInput,
  ): Promise<string> {
    const reason = requireReasonCode(reasonInput, REASON_CODES.legalHold);
    return this.tenantTx.withTenantTx(async (tx) => {
      const account = await this.lockAccount(tx, accountId);
      if (account.status === 'erased') throw accountNotFound();
      const open = await tx.legalHold.count({
        where: { accountId, releasedAt: null },
      });
      if (open) {
        throw appError.conflict(
          ErrorCode.LEGAL_HOLD_ACTIVE,
          'A legal hold is already active',
        );
      }
      const id = newId();
      await tx.legalHold.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          accountId,
          reasonCode: reason.code,
          note: reason.text,
          placedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'account.legal_hold_placed',
        targetId: accountId,
        metadata: { holdId: id, reasonCode: reason.code },
      });
      // The person learns their erasure is on hold — never why (D9).
      await this.tell(tx, accountId, ACCOUNT_EMAILS.legalHoldPlaced, {});
      return id;
    });
  }

  async releaseLegalHold(
    holdId: string,
    reasonInput: ReasonInput,
  ): Promise<void> {
    const reason = requireReasonCode(
      reasonInput,
      REASON_CODES.legalHoldRelease,
    );
    await this.tenantTx.withTenantTx(async (tx) => {
      const hold = await tx.legalHold.findFirst({
        where: { id: holdId, releasedAt: null },
      });
      if (!hold) {
        throw appError.notFound(
          ErrorCode.LEGAL_HOLD_NOT_FOUND,
          'Legal hold not found',
        );
      }
      await this.lockAccount(tx, hold.accountId);
      await tx.legalHold.update({
        where: { id: holdId },
        data: {
          releasedAt: new Date(),
          releasedById: this.ctx.accountId,
          releaseReasonCode: reason.code,
        },
      });
      await this.audit.record(tx, {
        action: 'account.legal_hold_released',
        targetId: hold.accountId,
        metadata: { holdId, reasonCode: reason.code },
      });
    });
  }

  /**
   * Step 3: erase a queued request (or a pending one past its cooling-off)
   * once its blockers are cleared. Refused before the grace ends, while
   * anything blocks it (a legal hold among them), and unless the scope
   * phrase is typed exactly. The account row is locked first — placing a
   * hold, becoming a primary and the sweep take the same lock, so none of
   * them crosses an erasure.
   */
  async erase(
    requestId: string,
    typedScope: string,
    now: Date = new Date(),
  ): Promise<void> {
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.accountDeletionRequest.findFirst({
        where: { id: requestId, status: { in: ['pending', 'queued'] } },
        select: { accountId: true },
      });
      if (!found) throw requestNotFound();
      const account = await this.lockAccount(tx, found.accountId);
      const request = await tx.accountDeletionRequest.findFirst({
        where: { id: requestId, status: { in: ['pending', 'queued'] } },
      });
      if (!request) throw requestNotFound();
      if (request.status === 'pending' && request.effectiveAt > now) {
        throw appError.conflict(
          ErrorCode.DELETION_GRACE_NOT_OVER,
          'The holder can still undo: the grace period has not ended',
          { params: { effectiveAt: request.effectiveAt.toISOString() } },
        );
      }
      const blockers = await this.blockers(tx, account);
      if (blockers.includes('legal_hold')) {
        throw appError.conflict(
          ErrorCode.LEGAL_HOLD_ACTIVE,
          'A legal hold blocks erasure',
        );
      }
      if (blockers.length) throw deletionBlocked(blockers);
      if ((typedScope ?? '').trim() !== scopePhrase(account.id)) {
        throw appError.badRequest(
          ErrorCode.SCOPE_CONFIRMATION_MISMATCH,
          'Type the erasure scope exactly',
        );
      }
      after.push(...(await this.eraseIn(tx, account, request.id)));
    });
    await runAfterCommit(after, this.logger);
  }

  /** Closes a queued request without erasing (a reason code, ADR 0036). */
  async closeQueued(
    requestId: string,
    reasonCode: string | undefined,
  ): Promise<void> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.deletionClose);
    await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.accountDeletionRequest.findFirst({
        where: { id: requestId, status: 'queued' },
        select: { accountId: true },
      });
      if (!found) throw requestNotFound();
      await this.lockAccount(tx, found.accountId);
      const request = await tx.accountDeletionRequest.findFirst({
        where: { id: requestId, status: 'queued' },
      });
      if (!request) throw requestNotFound();
      await tx.accountDeletionRequest.update({
        where: { id: requestId },
        data: {
          status: 'closed',
          closedAt: new Date(),
          closedById: this.ctx.accountId,
          closeReasonCode: code,
        },
      });
      await this.audit.record(tx, {
        action: 'account.deletion_closed',
        targetId: request.accountId,
        changes: diffChanges(
          { status: 'queued' },
          { status: 'closed' },
          'account.deletion_closed',
        ),
        metadata: { requestId, reasonCode: code },
      });
      await this.notifier.notify(tx, [request.accountId], {
        kind: 'account.deletion_closed',
        params: { reason: code },
        targetId: requestId,
      });
      await this.tell(tx, request.accountId, ACCOUNT_EMAILS.deletionClosed, {});
    });
  }

  // --------------------------------------------------------------------------
  // The sweep
  // --------------------------------------------------------------------------

  /** Reminders two days before, then the executions that are due. */
  async runDue(now: Date = new Date()): Promise<number> {
    let done = await this.remind(now);
    const due: { id: string; accountId: string; tenantId: string }[] = [];
    await this.sweep.forEachTenant(async (tx, tenantId) => {
      const rows = await tx.accountDeletionRequest.findMany({
        where: { status: 'pending', effectiveAt: { lte: now } },
        orderBy: { effectiveAt: 'asc' },
        select: { id: true, accountId: true },
        take: 100,
      });
      due.push(...rows.map((r) => ({ ...r, tenantId })));
      return rows.length;
    });
    for (const d of due) {
      try {
        done += await this.executeOne(d, now);
      } catch (error) {
        this.logger.error(
          `deletion ${d.id} failed (${error instanceof Error ? error.name : 'Error'})`,
        );
      }
    }
    return done;
  }

  /** Once per request, two days before its execution. */
  private async remind(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.$queryRaw<
        { id: string; account_id: string; effective_at: Date }[]
      >`
        UPDATE account_deletion_requests SET reminded_at = ${now}
         WHERE status = 'pending' AND reminded_at IS NULL
           AND effective_at > ${now}
           AND effective_at <= ${new Date(now.getTime() + DELETION_REMINDER_MS)}
        RETURNING id, account_id, effective_at`;
      for (const r of due) {
        await this.notifier.notify(tx, [r.account_id], {
          kind: 'account.deletion_reminder',
          params: { effectiveAt: r.effective_at.toISOString() },
          targetId: r.id,
        });
        await this.tell(tx, r.account_id, ACCOUNT_EMAILS.deletionReminder, {
          effectiveDate: r.effective_at.toISOString().slice(0, 10),
        });
      }
      return due.length;
    });
  }

  /**
   * One due request, in a transaction of its own, as the system: the
   * account's row is locked, the request read again (a cancel may have
   * won), the blockers checked again — then the erasure, or the queue.
   */
  private async executeOne(
    d: { id: string; accountId: string; tenantId: string },
    now: Date,
  ): Promise<number> {
    return this.cls.run(async () => {
      this.cls.set('tenantId', d.tenantId);
      this.cls.set('auditActor', { type: 'system', id: null });
      const after: AfterCommit[] = [];
      const done = await this.tenantTx.withTenantTx(async (tx) => {
        const account = await this.lockAccount(tx, d.accountId);
        const request = await tx.accountDeletionRequest.findFirst({
          where: { id: d.id, status: 'pending', effectiveAt: { lte: now } },
        });
        if (!request) return 0;
        const blockers = await this.blockers(tx, account);
        if (blockers.length) {
          await this.queue(tx, request.id, account.id, blockers, now);
          return 1;
        }
        after.push(...(await this.eraseIn(tx, account, request.id)));
        return 1;
      });
      await runAfterCommit(after, this.logger);
      return done;
    });
  }

  /** Blocked at execution: the managers' queue, and everyone is told. */
  private async queue(
    tx: TenantTxClient,
    requestId: string,
    accountId: string,
    blockers: string[],
    now: Date,
  ): Promise<void> {
    await tx.accountDeletionRequest.update({
      where: { id: requestId },
      data: { status: 'queued', queuedAt: now, blockerCodes: blockers },
    });
    await this.audit.record(tx, {
      action: 'account.deletion_queued',
      targetId: accountId,
      changes: diffChanges(
        { status: 'pending' },
        { status: 'queued' },
        'account.deletion_queued',
      ),
      metadata: { requestId, blockers },
    });
    const codes = blockers.join(',');
    await this.notifier.notify(tx, [accountId], {
      kind: 'account.deletion_delayed',
      params: { blockers: codes },
      targetId: requestId,
    });
    await this.tell(tx, accountId, ACCOUNT_EMAILS.deletionDelayed, {
      blockers: codes,
    });
    const holders = await this.staff.holding(tx, 'accounts.erase');
    await this.notifier.notify(
      tx,
      holders.map((h) => h.id),
      {
        kind: 'account.deletion_queued',
        params: { blockers: codes },
        targetId: requestId,
      },
    );
  }

  // --------------------------------------------------------------------------

  private async eraseIn(
    tx: TenantTxClient,
    account: { id: string; tenantId: string; status: string },
    requestId: string,
  ): Promise<AfterCommit[]> {
    const accountId = account.id;
    const tenantId = account.tenantId;
    // 1. The domains end what hangs off the account (occupancies, household,
    //    workers they registered, delegations), with their own notices.
    const after = await this.lifecycle.erasing(tx, { id: accountId, tenantId });
    const global = this.globalDb.in(tx);
    // 2. Login and sessions: gone (sessions hold IP and user agent).
    const { count: identifiers } = await global.loginIdentifier.deleteMany({
      where: { accountId },
    });
    const { count: sessions } = await global.session.deleteMany({
      where: { accountId },
    });
    await global.otpChallenge.updateMany({
      where: {
        accountIds: { has: accountId },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
    // 3. Mail still waiting for this account is stripped, as dead evidence.
    const { count: messagesStripped } = await global.outboxMessage.updateMany({
      where: {
        recipientAccountId: accountId,
        status: { in: ['pending', 'processing', 'held'] },
      },
      data: {
        status: 'dead',
        recipient: null,
        params: Prisma.DbNull,
        strippedAt: new Date(),
        lockedUntil: null,
        lastErrorCode: NO_RECIPIENT,
      },
    });
    // 4. Invites that brought them in lose the personal data they carried.
    const { count: invitesStripped } = await tx.householdInvite.updateMany({
      where: { acceptedAccountId: accountId, strippedAt: null },
      data: {
        strippedAt: new Date(),
        fullName: null,
        phone: null,
        email: null,
        idDocumentType: null,
        idDocumentNumber: null,
        nationality: null,
        birthDate: null,
      },
    });
    await tx.accountFreeze.updateMany({
      where: { accountId },
      data: { note: null },
    });
    // 5. A last word to the person, queued before the address is gone; the
    //    normal retention deletes it once sent (D24).
    await this.tell(tx, accountId, ACCOUNT_EMAILS.erased, {});
    // 6. The tombstone.
    await tx.account.update({
      where: { id: accountId },
      data: {
        status: 'erased',
        fullName: null,
        phone: null,
        email: null,
        idDocumentType: null,
        idDocumentNumber: null,
        nationality: null,
        birthDate: null,
      },
    });
    await tx.accountDeletionRequest.update({
      where: { id: requestId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        // The sweep erases too (ADR 0036): no request account then.
        completedById: this.ctx.accountIdOrNull(),
      },
    });
    await this.audit.record(tx, {
      action: 'account.erased',
      targetId: accountId,
      // Every personal field changed; none by value (ADR 0014).
      changes: {
        status: { from: account.status, to: 'erased' },
        ...Object.fromEntries(
          PERSONAL_FIELDS.map((f) => [f, { changed: true as const }]),
        ),
      },
      metadata: {
        requestId,
        identifiersDeleted: identifiers,
        sessionsDeleted: sessions,
        messagesStripped,
        invitesStripped,
      },
    });
    return after;
  }

  /** The account row, locked for the rest of the transaction. */
  private async lockAccount(tx: TenantTxClient, accountId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
    if (!rows.length) throw accountNotFound();
    return tx.account.findUniqueOrThrow({ where: { id: accountId } });
  }

  private async tell(
    tx: TenantTxClient,
    accountId: string,
    templateKey: string,
    params: Record<string, string>,
  ) {
    const account = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { email: true, preferredLocale: true, tenantId: true },
    });
    if (!account.email) return;
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: account.tenantId },
      select: { name: true },
    });
    await this.outbox.enqueue(tx, {
      tenantId: account.tenantId,
      templateKey,
      locale: account.preferredLocale,
      recipient: account.email,
      params: { compoundName: tenant.name, ...params },
      // The final "erased" email must survive the strip that just ran.
      recipientAccountId:
        templateKey === ACCOUNT_EMAILS.erased ? null : accountId,
    });
  }
}

/** What step 3 must type: short, unambiguous, tied to this account. */
export function scopePhrase(accountId: string): string {
  return `ERASE ${accountId.slice(0, 8)}`;
}

function view(r: {
  id: string;
  status: RequestStatus;
  requestedAt: Date;
  effectiveAt: Date;
  assisted: boolean;
  blockerCodes: string[];
}): DeletionRequestView {
  return {
    id: r.id,
    status: r.status,
    requestedAt: r.requestedAt,
    effectiveAt: r.effectiveAt,
    assisted: r.assisted,
    blockers: r.status === 'queued' ? [...r.blockerCodes] : [],
  };
}

/** Refused while something blocks the erasure (409, params.blockers). */
function deletionBlocked(blockers: string[]) {
  return appError.conflict(
    ErrorCode.DELETION_BLOCKED,
    'Something keeps this account from being deleted now',
    { params: { blockers } },
  );
}

function requestNotFound() {
  return appError.notFound(
    ErrorCode.DELETION_REQUEST_NOT_FOUND,
    'Deletion request not found',
  );
}

function accountNotFound() {
  return appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Account not found');
}
