import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import type { DecisionAppeal } from '@prisma/client';
import { CommunityManagementPort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  DecisionAppeals,
  type DecisionAppealEffect,
  type DecisionAppealHandler,
  type DecisionAppealKind,
  type OverturnInput,
} from '../../core/decision-appeals/decision-appeals';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';
import {
  DECISION_APPEAL_WINDOW_DAYS,
  type DecisionAppealOutcome,
  type DecisionAppealStatus,
} from './appeal-rules';
import { DecisionAppealView } from './views/decision-appeal.views';

export const DECISION_APPEAL_RESOURCE = 'decision_appeal';
const PAGE = keysetCursor('lodgedAt', 'desc');
// A real 24 h: the window runs from the decision's instant, as the board's.
const DAY = 86_400_000;

export interface NewDecisionAppeal {
  kind: DecisionAppealKind;
  subjectId: string;
  grounds: string;
  attachmentIds?: string[];
}

export interface DecideInput extends OverturnInput {
  outcome: DecisionAppealOutcome;
  rationale: string;
}

/** An appeal with what every view of it needs. */
export interface DecisionAppealRecord {
  appeal: DecisionAppeal;
  unitCode: string;
  /** The decision appealed, as its domain describes it (codes, dates). */
  subject: unknown;
  /** Its attachments (the appellant's and the deciders' eyes only). */
  attachments: { fileId: string; url: string | null }[];
  mine: boolean;
}

const appealNotFound = () =>
  appError.notFound(
    ErrorCode.DECISION_APPEAL_NOT_FOUND,
    'Decision appeal not found',
  );

const subjectNotFound = () =>
  appError.notFound(
    ErrorCode.DECISION_APPEAL_SUBJECT_NOT_FOUND,
    'No such decision to appeal',
  );

const notPending = (status: string) =>
  appError.conflict(
    ErrorCode.DECISION_APPEAL_NOT_PENDING,
    'The appeal was decided or withdrawn already',
    { params: { status } },
  );

/**
 * Decision appeals (ADR 0059): a resident appeals a staff decision about
 * their unit to the management within 15 days of it, once per decision. The
 * decision's domain registered its kind with core's DecisionAppeals: it
 * says who may appeal, locks and judges the decision at the lodge, and runs
 * an overturn through its normal approval in the deciding transaction —
 * what a check refuses is left to the management (`follow_up`), never
 * forced. A manager (`appeals.decide`) who did not take the decision
 * decides, with a rationale the appellant reads; the decider's role is kept
 * as it was named then, never a person's name.
 *
 * Who sees what: the appellant reads their appeal with their grounds; the
 * unit's primary sees it without them; the deciders see all.
 *
 * Lock order (ADR 0059): the caller's account (FOR SHARE), the accounts it
 * tells (FOR KEY SHARE, in id order), the appeal (FOR UPDATE), then its
 * subject, as its domain locks it; the counter last.
 */
@Injectable()
export class DecisionAppealsService
  implements OnModuleInit, OnApplicationBootstrap
{
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly registry: DecisionAppeals,
    private readonly community: CommunityManagementPort,
    private readonly staff: StaffRecipients,
    private readonly files: FilesService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(DECISION_APPEAL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const appeal = await tx.decisionAppeal.findUniqueOrThrow({
          where: { id },
        });
        // A replay's body as the route answers it: the appellant's view.
        return DecisionAppealView.from(await this.load(tx, appeal, true));
      }),
    );
    // The appellant's erasure: their grounds and attachments go; the
    // appeal, its rationale and its effect stay (ADR 0059).
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id);
      return [];
    });
  }

  onApplicationBootstrap(): void {
    const missing = this.registry.missing();
    if (missing.length)
      throw new Error(
        `Decision appeal kinds without a handler: ${missing.join(', ')}`,
      );
  }

  // --------------------------------------------------------------------------
  // The residents
  // --------------------------------------------------------------------------

  lodge(input: NewDecisionAppeal): Promise<DecisionAppealRecord> {
    const ids = input.attachmentIds ?? [];
    if (new Set(ids).size !== ids.length)
      throw invalid([
        { field: 'attachmentIds', code: FieldErrorCode.DUPLICATE_VALUE },
      ]);
    const handler = this.handler(input.kind);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockSelf(tx);
      // Accounts first: the deciders it tells.
      const deciders = await this.deciders(tx);
      await this.lockAccounts(tx, deciders);
      // The decision, locked and judged by its domain.
      const resolved = await handler.resolve(
        tx,
        input.subjectId,
        this.ctx.accountId,
      );
      if (!resolved) throw subjectNotFound();
      if (!resolved.mayAppeal)
        throw appError.forbidden(
          ErrorCode.DECISION_APPEAL_NOT_ALLOWED,
          'Only those the decision is about appeal it',
        );
      if (
        await tx.decisionAppeal.findFirst({
          where: { kind: input.kind, subjectId: input.subjectId },
          select: { id: true },
        })
      )
        throw appError.conflict(
          ErrorCode.DECISION_APPEAL_EXISTS,
          'The decision was appealed already',
        );
      if (resolved.refused || !resolved.decidedAt)
        throw appError.conflict(
          ErrorCode.DECISION_APPEAL_NOT_ELIGIBLE,
          'The decision cannot be appealed now',
          { params: { reason: resolved.refused ?? 'not_decided' } },
        );
      const now = await dbNow(tx);
      const until = new Date(
        resolved.decidedAt.getTime() + DECISION_APPEAL_WINDOW_DAYS * DAY,
      );
      if (now >= until)
        throw appError.conflict(
          ErrorCode.DECISION_APPEAL_WINDOW_PASSED,
          'The days to appeal the decision have passed',
          { params: { until: until.toISOString() } },
        );
      const id = newId();
      await this.idempotency.claim(tx, { type: DECISION_APPEAL_RESOURCE, id });
      const appeal = await tx.decisionAppeal.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number: await this.nextNumber(tx),
          kind: input.kind,
          subjectId: input.subjectId,
          unitId: resolved.unitId,
          appellantId: this.ctx.accountId,
          grounds: input.grounds,
          decisionAt: resolved.decidedAt,
          decisionById: resolved.deciderId,
          lodgedAt: now,
        },
      });
      for (const [i, fileId] of ids.entries()) {
        const file = await this.files.claim(
          tx,
          fileId,
          'decision_appeal_attachment',
        );
        if (!file)
          throw invalid([
            {
              field: `attachmentIds[${i}]`,
              code: FieldErrorCode.FILE_NOT_AVAILABLE,
            },
          ]);
        await this.files.attach(tx, file);
        await tx.decisionAppealAttachment.create({
          data: {
            tenantId: this.ctx.txTenantId,
            appealId: id,
            fileId,
            position: i + 1,
          },
        });
      }
      await handler.lodged(tx, input.subjectId, now);
      await this.audit.record(tx, {
        action: 'decision_appeal.lodged',
        targetId: id,
        changes: diffChanges(
          null,
          {
            number: appeal.number,
            kind: input.kind,
            subjectId: input.subjectId,
            unitId: resolved.unitId,
            decisionAt: resolved.decidedAt,
            attachments: ids.length,
            grounds: input.grounds,
          },
          'decision_appeal.lodged',
        ),
      });
      await this.tell(tx, deciders, 'decision_appeal.lodged', appeal);
      return this.load(tx, appeal, true);
    });
  }

  /** The appellant withdraws a pending appeal (the decision's mark closes). */
  withdraw(id: string): Promise<DecisionAppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockSelf(tx);
      const appeal = await this.lockRow(tx, id);
      if (appeal.appellantId !== this.ctx.accountId) {
        if (!(await this.visibleTo(tx, appeal))) throw appealNotFound();
        throw appError.forbidden(
          ErrorCode.DECISION_APPEAL_NOT_YOURS,
          'Only the appellant withdraws an appeal',
        );
      }
      if (appeal.status !== 'pending') throw notPending(appeal.status);
      const now = await dbNow(tx);
      await this.handler(appeal.kind as DecisionAppealKind).closed(
        tx,
        appeal.subjectId,
        'withdrawn',
        {
          now,
          decidedById: null,
          decisionAt: appeal.decisionAt,
          appealId: appeal.id,
        },
      );
      const withdrawn = await tx.decisionAppeal.update({
        where: { id },
        data: { status: 'withdrawn', withdrawnAt: now, effect: 'none' },
      });
      await this.audit.record(tx, {
        action: 'decision_appeal.withdrawn',
        targetId: id,
      });
      return this.load(tx, withdrawn, true);
    });
  }

  /** The caller's own appeals and those of the units they are primary of. */
  residentList(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<DecisionAppealRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const units = await this.community.primaryUnits(tx, this.ctx.accountId);
      const limit = clampLimit(q.limit);
      const rows = await tx.decisionAppeal.findMany({
        where: {
          AND: [
            {
              OR: [
                { appellantId: this.ctx.accountId },
                { unitId: { in: units } },
              ],
            },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: DecisionAppealRecord[] = [];
      for (const a of page.items) items.push(await this.load(tx, a, true));
      return { items, nextCursor: page.nextCursor };
    });
  }

  residentGet(id: string): Promise<DecisionAppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const appeal = await tx.decisionAppeal.findUnique({ where: { id } });
      if (!appeal || !(await this.visibleTo(tx, appeal)))
        throw appealNotFound();
      return this.load(tx, appeal, true);
    });
  }

  // --------------------------------------------------------------------------
  // The deciders (`appeals.decide`)
  // --------------------------------------------------------------------------

  staffList(q: {
    status?: DecisionAppealStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<DecisionAppealRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.decisionAppeal.findMany({
        where: {
          AND: [q.status ? { status: q.status } : {}, ...PAGE.after(q.cursor)],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: DecisionAppealRecord[] = [];
      for (const a of page.items) items.push(await this.load(tx, a, false));
      return { items, nextCursor: page.nextCursor };
    });
  }

  staffGet(id: string): Promise<DecisionAppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const appeal = await tx.decisionAppeal.findUnique({ where: { id } });
      if (!appeal) throw appealNotFound();
      return this.load(tx, appeal, true);
    });
  }

  /**
   * A manager decides a pending appeal, once, with a rationale. Never the
   * one who took the decision (APPEAL_DECIDER_CONFLICT). An overturn runs
   * the domain's normal approval as the decider; what it refuses is
   * `follow_up` with the reason, for the management to act on.
   */
  decide(id: string, input: DecideInput): Promise<DecisionAppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockSelf(tx);
      const peek = await tx.decisionAppeal.findUnique({ where: { id } });
      if (!peek) throw appealNotFound();
      // Accounts first: the appellant and the unit's primary it tells.
      const told = await this.told(tx, peek);
      await this.lockAccounts(tx, told);
      const appeal = await this.lockRow(tx, id);
      if (appeal.status !== 'pending') throw notPending(appeal.status);
      if (appeal.decisionById === this.ctx.accountId)
        throw appError.conflict(
          ErrorCode.APPEAL_DECIDER_CONFLICT,
          'The decision appealed is the caller’s own: another manager decides',
        );
      const role = await tx.account.findUniqueOrThrow({
        where: { id: this.ctx.accountId },
        select: { role: { select: { key: true, name: true } } },
      });
      const now = await dbNow(tx);
      const result: DecisionAppealEffect = await this.handler(
        appeal.kind as DecisionAppealKind,
      ).closed(tx, appeal.subjectId, input.outcome, {
        now,
        decidedById: this.ctx.accountId,
        decisionAt: appeal.decisionAt,
        appealId: appeal.id,
        overturn:
          input.outcome === 'overturned'
            ? {
                stickerNumber: input.stickerNumber,
                permitValidUntil: input.permitValidUntil,
              }
            : undefined,
      });
      const effect: DecisionAppealEffect =
        input.outcome === 'upheld' ? { effect: 'none' } : result;
      const decided = await tx.decisionAppeal.update({
        where: { id },
        data: {
          status: input.outcome,
          decidedAt: now,
          decidedById: this.ctx.accountId,
          deciderRoleKey: role.role.key,
          deciderRoleName: role.role.name,
          rationale: input.rationale,
          effect: effect.effect,
          effectReason: effect.reason ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'decision_appeal.decided',
        targetId: id,
        changes: diffChanges(
          null,
          { rationale: input.rationale },
          'decision_appeal.decided',
        ),
        metadata: {
          outcome: input.outcome,
          effect: effect.effect,
          effectReason: effect.reason ?? null,
          deciderRoleKey: role.role.key,
        },
      });
      await this.tell(tx, told, 'decision_appeal.decided', decided, {
        outcome: input.outcome,
      });
      return this.load(tx, decided, true);
    });
  }

  /** The manager followed an overturn left to the management up, once. */
  followedUp(id: string): Promise<DecisionAppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockSelf(tx);
      const appeal = await this.lockRow(tx, id);
      if (
        appeal.status !== 'overturned' ||
        appeal.effect !== 'follow_up' ||
        appeal.followedUpAt
      )
        throw appError.conflict(
          ErrorCode.DECISION_APPEAL_NO_FOLLOW_UP,
          'No follow-up is due',
        );
      const done = await tx.decisionAppeal.update({
        where: { id },
        data: {
          followedUpAt: await dbNow(tx),
          followedUpById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'decision_appeal.followed_up',
        targetId: id,
      });
      return this.load(tx, done, true);
    });
  }

  // --------------------------------------------------------------------------
  // In other transactions: the erasure
  // --------------------------------------------------------------------------

  /**
   * An erasure (the account's row held): its appeals' grounds go, once,
   * and their attachments' files are marked deleted.
   */
  async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM decision_appeals
       WHERE appellant_account_id = ${accountId}::uuid AND grounds_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      await tx.decisionAppeal.update({
        where: { id },
        data: { grounds: null, groundsClearedAt: now },
      });
      let deleted = 0;
      for (const a of await tx.decisionAppealAttachment.findMany({
        where: { appealId: id },
      })) {
        const file = await tx.storedFile.findUnique({
          where: { id: a.fileId },
          select: { id: true, purpose: true },
        });
        if (file && (await this.files.markDeleted(tx, file, 'erasure')))
          deleted++;
      }
      await this.audit.record(tx, {
        action: 'decision_appeal.grounds_cleared',
        targetId: id,
        metadata: { attachments: deleted },
      });
    }
  }

  // --------------------------------------------------------------------------

  private handler(kind: DecisionAppealKind): DecisionAppealHandler {
    const handler = this.registry.handler(kind);
    if (!handler) throw subjectNotFound();
    return handler;
  }

  /** Who decides appeals now: the `appeals.decide` holders. */
  private async deciders(tx: TenantTxClient): Promise<string[]> {
    return (await this.staff.holding(tx, 'appeals.decide')).map((r) => r.id);
  }

  /** The appellant and the unit's primary: who a decision tells. */
  private async told(
    tx: TenantTxClient,
    appeal: Pick<DecisionAppeal, 'appellantId' | 'unitId'>,
  ): Promise<string[]> {
    const primary = await this.community.primaryOf(tx, appeal.unitId);
    return [...new Set([appeal.appellantId, ...(primary ? [primary] : [])])];
  }

  /** The active accounts among `to`, never the caller (who acted). */
  private async tell(
    tx: TenantTxClient,
    to: readonly string[],
    kind: NotificationKind,
    appeal: DecisionAppeal,
    extra: Record<string, string> = {},
  ): Promise<void> {
    const ids = [...new Set(to)].filter((id) => id !== this.ctx.accountId);
    if (!ids.length) return;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
    });
    if (!active.length) return;
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind, params: { kind: appeal.kind, ...extra }, targetId: appeal.id },
    );
  }

  private async visibleTo(
    tx: TenantTxClient,
    appeal: DecisionAppeal,
  ): Promise<boolean> {
    return (
      appeal.appellantId === this.ctx.accountId ||
      (await this.community.primaryOf(tx, appeal.unitId)) === this.ctx.accountId
    );
  }

  /** The caller's own account row, shared-locked (ADR 0023). */
  private async lockSelf(tx: TenantTxClient): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${this.ctx.accountId}::uuid FOR SHARE`;
    if (rows[0]?.status !== 'active')
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }

  /** Accounts a write tells (FOR KEY SHARE, in id order): none goes mid-write. */
  private async lockAccounts(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<void> {
    const sorted = [...new Set(ids)].sort();
    if (!sorted.length) return;
    await tx.$queryRaw`
      SELECT id FROM accounts WHERE id = ANY(${sorted}::uuid[])
       ORDER BY id FOR KEY SHARE`;
  }

  private async lockRow(
    tx: TenantTxClient,
    id: string,
  ): Promise<DecisionAppeal> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM decision_appeals WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw appealNotFound();
    return tx.decisionAppeal.findUniqueOrThrow({ where: { id } });
  }

  /** The next AP- number: the counter's row, locked to the commit (gapless). */
  private async nextNumber(tx: TenantTxClient): Promise<number> {
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO decision_appeal_counters (tenant_id, last_number)
      VALUES (${this.ctx.txTenantId}::uuid, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET last_number = decision_appeal_counters.last_number + 1
      RETURNING last_number AS number`;
    return number;
  }

  private async load(
    tx: TenantTxClient,
    appeal: DecisionAppeal,
    withAttachments: boolean,
  ): Promise<DecisionAppealRecord> {
    const codes = await this.community.unitCodes(tx, [appeal.unitId]);
    const attachments: DecisionAppealRecord['attachments'] = [];
    if (withAttachments)
      for (const a of await tx.decisionAppealAttachment.findMany({
        where: { appealId: appeal.id },
        orderBy: { position: 'asc' },
      }))
        attachments.push({
          fileId: a.fileId,
          url: (await this.files.readUrl(tx, a.fileId))?.url ?? null,
        });
    const handler = this.registry.handler(appeal.kind as DecisionAppealKind);
    return {
      appeal,
      unitCode: codes.get(appeal.unitId) ?? '',
      subject: handler ? await handler.describe(tx, appeal.subjectId) : null,
      attachments,
      mine: appeal.appellantId === this.ctx.accountId,
    };
  }
}
