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
  type ReasonInput,
} from '../common/reasons';
import { newId } from '../common/uuid';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { NO_RECIPIENT, Outbox } from '../mail/outbox';
import { SweepRunner } from '../sweep/sweep-runner';
import { ACCOUNT_EMAILS } from './account-emails';
import {
  AccountLifecycle,
  runAfterCommit,
  type AfterCommit,
} from './account-lifecycle';

export const ERASURE_OVERDUE_SWEEP = 'accounts.erasure_overdue';

/** Most overdue first: the oldest end of grace. */
const ERASURE_PAGE = keysetCursor('effectiveAt', 'asc');

/** The words the holder types to confirm (02 §4), per language. */
export const CONFIRMATION_WORDS = ['حذف', 'DELETE'] as const;

export interface DeletionRequestView {
  id: string;
  status: 'pending' | 'cancelled' | 'completed';
  requestedAt: Date;
  /** Undo is possible until then; erasure only after it. */
  effectiveAt: Date;
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
 * Account deletion (ADR 0023; 02 §4, 09 §4–5).
 *
 * - The holder asks with a confirmation word and can undo until the grace
 *   period ends (DELETION_GRACE_DAYS). The account stays usable meanwhile.
 * - After it, staff holding `accounts.erase` erase it in three steps:
 *   scope → legal hold check → typed scope. A legal hold blocks erasure.
 * - Erasure makes a TOMBSTONE: the row stays with every personal field
 *   NULL, so audit and financial records keep their pointer and show a
 *   deleted user. Login identifiers and sessions are deleted, pending mail
 *   to that account is stripped, invites that brought them in lose their
 *   personal data, and the domains end what hangs off the account
 *   (AccountLifecycle.onErasing). The audit log is never touched.
 * - A request left pending ERASURE_OVERDUE_DAYS after its grace ends is
 *   reported to the erasure holders by the sweep (once).
 */
@Injectable()
export class AccountDeletionService implements OnModuleInit {
  private readonly logger = new Logger(AccountDeletionService.name);
  private readonly graceMs: number;
  private readonly overdueMs: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly audit: AuditService,
    private readonly outbox: Outbox,
    private readonly staff: StaffRecipients,
    private readonly lifecycle: AccountLifecycle,
    private readonly sweep: SweepRunner,
  ) {
    this.graceMs =
      config.get('DELETION_GRACE_DAYS', { infer: true }) * 86_400_000;
    this.overdueMs =
      config.get('ERASURE_OVERDUE_DAYS', { infer: true }) * 86_400_000;
  }

  onModuleInit(): void {
    this.sweep.register(ERASURE_OVERDUE_SWEEP, (now) =>
      this.reportOverdue(now),
    );
  }

  // --------------------------------------------------------------------------
  // The holder
  // --------------------------------------------------------------------------

  async requestDeletion(confirmation: string): Promise<DeletionRequestView> {
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
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockAccount(tx, accountId);
      const open = await tx.accountDeletionRequest.count({
        where: { accountId, status: 'pending' },
      });
      if (open) {
        throw appError.conflict(
          ErrorCode.DELETION_ALREADY_REQUESTED,
          'A deletion is already pending',
        );
      }
      const now = new Date();
      const request = await tx.accountDeletionRequest.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          accountId,
          requestedAt: now,
          effectiveAt: new Date(now.getTime() + this.graceMs),
        },
      });
      await this.audit.record(tx, {
        action: 'account.deletion_requested',
        targetId: accountId,
        metadata: { requestId: request.id, effectiveAt: request.effectiveAt },
      });
      await this.tell(tx, accountId, ACCOUNT_EMAILS.deletionRequested, {
        effectiveDate: request.effectiveAt.toISOString().slice(0, 10),
      });
      return view(request);
    });
  }

  /** Undo, only within the grace period. */
  async cancelDeletion(): Promise<void> {
    const accountId = this.ctx.accountId;
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.lockAccount(tx, accountId);
      const request = await tx.accountDeletionRequest.findFirst({
        where: { accountId, status: 'pending' },
      });
      if (!request) throw requestNotFound();
      if (request.effectiveAt <= new Date()) {
        throw appError.conflict(
          ErrorCode.DELETION_GRACE_OVER,
          'The grace period has ended',
        );
      }
      await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      await this.audit.record(tx, {
        action: 'account.deletion_cancelled',
        targetId: accountId,
        changes: diffChanges(
          { status: 'pending' },
          { status: 'cancelled' },
          'account.deletion_cancelled',
        ),
        metadata: { requestId: request.id },
      });
      await this.tell(tx, accountId, ACCOUNT_EMAILS.deletionCancelled, {});
    });
  }

  async myDeletionRequest(): Promise<DeletionRequestView | null> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const request = await tx.accountDeletionRequest.findFirst({
        where: { accountId: this.ctx.accountId },
        orderBy: { requestedAt: 'desc' },
      });
      return request ? view(request) : null;
    });
  }

  // --------------------------------------------------------------------------
  // Staff (`accounts.erase`, `accounts.legal_hold`)
  // --------------------------------------------------------------------------

  /**
   * Pending requests, most overdue first (oldest `effectiveAt`), a page at
   * a time, with their age and hold.
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
            { status: 'pending' },
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
        where: { id: requestId, status: 'pending' },
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
   * Step 3: erase. Refused before the grace period ends, while a legal hold
   * is active, and unless the scope phrase is typed exactly. The account
   * row is locked first — placing a hold takes the same lock, so a hold
   * and an erasure can never cross.
   */
  async erase(requestId: string, typedScope: string): Promise<void> {
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.accountDeletionRequest.findFirst({
        where: { id: requestId, status: 'pending' },
        select: { accountId: true },
      });
      if (!found) throw requestNotFound();
      const account = await this.lockAccount(tx, found.accountId);
      const request = await tx.accountDeletionRequest.findFirst({
        where: { id: requestId, status: 'pending' },
      });
      if (!request) throw requestNotFound();
      if (request.effectiveAt > new Date()) {
        throw appError.conflict(
          ErrorCode.DELETION_GRACE_NOT_OVER,
          'The holder can still undo: the grace period has not ended',
          { params: { effectiveAt: request.effectiveAt.toISOString() } },
        );
      }
      const holds = await tx.legalHold.count({
        where: { accountId: account.id, releasedAt: null },
      });
      if (holds) {
        throw appError.conflict(
          ErrorCode.LEGAL_HOLD_ACTIVE,
          'A legal hold blocks erasure',
        );
      }
      if ((typedScope ?? '').trim() !== scopePhrase(account.id)) {
        throw appError.badRequest(
          ErrorCode.SCOPE_CONFIRMATION_MISMATCH,
          'Type the erasure scope exactly',
        );
      }
      after.push(
        ...(await this.eraseIn(tx, account.id, account.tenantId, request.id)),
      );
    });
    await runAfterCommit(after, this.logger);
  }

  // --------------------------------------------------------------------------

  private async eraseIn(
    tx: TenantTxClient,
    accountId: string,
    tenantId: string,
    requestId: string,
  ): Promise<AfterCommit[]> {
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
        completedById: this.ctx.accountId,
      },
    });
    await this.audit.record(tx, {
      action: 'account.erased',
      targetId: accountId,
      // Every personal field changed; none by value (ADR 0014).
      changes: {
        status: { from: 'active', to: 'erased' },
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

  /** The sweep: requests left pending too long after grace, once each. */
  async reportOverdue(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.overdueMs);
    const tenants = await this.globalDb.tenant.findMany({
      where: { status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let reported = 0;
    for (const t of tenants) {
      reported += await this.cls.run({ ifNested: 'inherit' }, () => {
        this.cls.set('auditActor', { type: 'system', id: null });
        return this.tenantTx.runInTenantUnsafe(t.id, async (tx) => {
          const due = await tx.$queryRaw<{ id: string; effective_at: Date }[]>`
            UPDATE account_deletion_requests SET overdue_notified_at = ${now}
             WHERE status = 'pending' AND overdue_notified_at IS NULL
               AND effective_at < ${before}
            RETURNING id, effective_at`;
          if (!due.length) return 0;
          const holders = await this.staff.holding(tx, 'accounts.erase');
          const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
            where: { id: t.id },
            select: { name: true },
          });
          for (const r of due) {
            const days = Math.floor(
              (now.getTime() - r.effective_at.getTime()) / 86_400_000,
            );
            if (!holders.length) {
              await this.outbox.recordUndeliverable(tx, {
                tenantId: t.id,
                templateKey: ACCOUNT_EMAILS.erasureOverdue,
              });
            }
            for (const h of holders) {
              await this.outbox.enqueue(tx, {
                tenantId: t.id,
                templateKey: ACCOUNT_EMAILS.erasureOverdue,
                locale: h.preferredLocale,
                recipient: h.email,
                params: {
                  compoundName: tenant.name,
                  requestId: r.id,
                  days: String(days),
                },
                recipientAccountId: h.id,
              });
            }
            await this.audit.record(tx, {
              action: 'account.erasure_overdue',
              targetId: r.id,
              metadata: {
                requestId: r.id,
                daysOverdue: days,
                holdersTold: holders.length,
              },
            });
          }
          return due.length;
        });
      });
    }
    return reported;
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
  status: 'pending' | 'cancelled' | 'completed';
  requestedAt: Date;
  effectiveAt: Date;
}): DeletionRequestView {
  return {
    id: r.id,
    status: r.status,
    requestedAt: r.requestedAt,
    effectiveAt: r.effectiveAt,
  };
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
