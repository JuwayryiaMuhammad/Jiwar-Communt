import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import type { BoardMotion, GovernanceBoardAppeal } from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import {
  BOARD_APPEAL_KINDS,
  BoardMatters,
  type BoardAppealKind,
} from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { GovernanceAccess } from '../access';
import { BoardService } from '../board/board.service';
import { nextGovernanceNumber } from '../counters';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import type { MatterRow } from '../motions/matters';
import { MotionsService, type MotionRecord } from '../motions/motions.service';
import { GovernanceSettingsService } from '../settings/governance-settings.service';
import {
  APPEAL_WINDOW_DAYS,
  type AppealEffect,
  type AppealStatus,
} from './appeal-rules';
import { BoardAppealView } from './views/appeals.views';

export const BOARD_APPEAL_RESOURCE = 'governance_board_appeal';
const PAGE = keysetCursor('lodgedAt', 'desc');
const DAY = 86_400_000;

/**
 * Every kind must have its domain's handler (ADR 0055): a rejected
 * invoice dispute's (finance), a fine's and a violation's (the gate), a
 * suspension's (facilities).
 */
const REQUIRED_KINDS: readonly BoardAppealKind[] = BOARD_APPEAL_KINDS;

export interface NewAppeal {
  kind: BoardAppealKind;
  subjectId: string;
  grounds: string;
  attachmentIds?: string[];
}

/** An appeal with what every view of it needs. */
export interface AppealRecord {
  appeal: GovernanceBoardAppeal;
  unitCode: string;
  /** The carried motion's reasons, once decided. */
  decision: BoardMotion | null;
  /** The decision appealed, as its domain describes it (codes, amounts, dates). */
  subject: unknown;
  /** Its attachments (the appellant's and the board's eyes only). */
  attachments: { fileId: string; url: string | null }[];
  mine: boolean;
  now: Date;
}

export interface BoardAppealRecord extends AppealRecord {
  motions: MotionRecord[];
}

const appealNotFound = () =>
  appError.notFound(ErrorCode.BOARD_APPEAL_NOT_FOUND, 'Board appeal not found');

const subjectNotFound = () =>
  appError.notFound(
    ErrorCode.BOARD_APPEAL_SUBJECT_NOT_FOUND,
    'No such decision to appeal',
  );

const notPending = (status: string) =>
  appError.conflict(
    ErrorCode.BOARD_APPEAL_NOT_PENDING,
    'The appeal was decided or withdrawn already',
    { params: { status } },
  );

/**
 * Appeals to the board (ADR 0055): an owner of a unit, or its primary,
 * takes a staff decision about it already taken to the board within 15
 * days, once per decision. The decision's domain registered its kind with
 * core's BoardMatters: it locks and judges the decision at the lodge,
 * marks it (so its own writers wait: a fine's payment, a violation's), and
 * applies an overturn in the deciding vote's transaction, or leaves it to
 * the management to follow up.
 *
 * Who sees what: the appellant reads their appeal with their grounds; the
 * unit's other owners and its primary see it without them; the staff (a
 * party: they decided) see the decision and its reasons, never the
 * grounds, a motion, a vote or a count; the board sees all. Members who
 * live in or own the unit, and the appellant, are recused from its motions.
 */
@Injectable()
export class BoardAppealsService
  implements OnModuleInit, OnApplicationBootstrap
{
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly board: BoardService,
    private readonly motions: MotionsService,
    private readonly matters: BoardMatters,
    private readonly settings: GovernanceSettingsService,
    private readonly community: CommunityGovernancePort,
    private readonly staff: StaffRecipients,
    private readonly files: FilesService,
    private readonly notices: GovernanceNotices,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(BOARD_APPEAL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const appeal = await tx.governanceBoardAppeal.findUniqueOrThrow({
          where: { id },
        });
        // A replay's body as the route answers it: the owner's view.
        return BoardAppealView.from(await this.load(tx, appeal, true));
      }),
    );
    this.motions.register({
      name: 'appeal',
      outcomes: ['uphold', 'overturn'],
      told: (tx, id) => this.told(tx, id),
      lock: (tx, id) => this.lockRow(tx, id),
      lockSkip: async (tx, id) =>
        (
          await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM governance_board_appeals
             WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`
        ).length > 0,
      recusals: (tx, matter) => this.recusals(tx, matter.id),
      decide: (tx, ev) => this.decide(tx, ev),
    });
  }

  onApplicationBootstrap(): void {
    const missing = this.matters.missing({
      approvals: [],
      appeals: REQUIRED_KINDS,
    });
    if (missing.length)
      throw new Error(`Board matters without a handler: ${missing.join(', ')}`);
  }

  // --------------------------------------------------------------------------
  // The owners
  // --------------------------------------------------------------------------

  lodge(input: NewAppeal): Promise<AppealRecord> {
    const ids = input.attachmentIds ?? [];
    if (new Set(ids).size !== ids.length)
      throw invalid([
        { field: 'attachmentIds', code: FieldErrorCode.DUPLICATE_VALUE },
      ]);
    const handler = this.matters.appeal(input.kind);
    if (!handler) throw subjectNotFound();
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // Accounts first: the board it tells.
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, await dbNow(tx)),
      );
      // The decision, locked and judged by its domain.
      const resolved = await handler.resolve(tx, input.subjectId);
      if (!resolved) throw subjectNotFound();
      if (
        !(await this.community.mayAppealFor(
          tx,
          this.ctx.accountId,
          resolved.unitId,
        ))
      )
        throw appError.forbidden(
          ErrorCode.BOARD_APPEAL_NOT_ALLOWED,
          'Only an owner of the unit, or its primary, appeals to the board',
        );
      if (
        await tx.governanceBoardAppeal.findFirst({
          where: { kind: input.kind, subjectId: input.subjectId },
          select: { id: true },
        })
      )
        throw appError.conflict(
          ErrorCode.BOARD_APPEAL_EXISTS,
          'The decision was taken to the board already',
        );
      if (resolved.refused || !resolved.decidedAt)
        throw appError.conflict(
          ErrorCode.BOARD_APPEAL_NOT_ELIGIBLE,
          'The decision does not stand against the unit now',
          { params: { reason: resolved.refused ?? 'not_decided' } },
        );
      const now = await dbNow(tx);
      const until = new Date(
        resolved.decidedAt.getTime() + APPEAL_WINDOW_DAYS * DAY,
      );
      if (now >= until)
        throw appError.conflict(
          ErrorCode.BOARD_APPEAL_WINDOW_PASSED,
          'The days to appeal to the board have passed',
          { params: { until: until.toISOString() } },
        );
      const id = newId();
      await this.idempotency.claim(tx, { type: BOARD_APPEAL_RESOURCE, id });
      const days = await this.settings.deadlineDays(tx, 'board_appeal');
      const appeal = await tx.governanceBoardAppeal.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number: await nextGovernanceNumber(tx, this.ctx.txTenantId, 'appeal'),
          kind: input.kind,
          subjectId: input.subjectId,
          unitId: resolved.unitId,
          appellantId: this.ctx.accountId,
          grounds: input.grounds,
          decisionAt: resolved.decidedAt,
          lodgedAt: now,
          deadlineAt: new Date(now.getTime() + days * DAY),
        },
      });
      for (const [i, fileId] of ids.entries()) {
        const file = await this.files.claim(
          tx,
          fileId,
          'board_appeal_attachment',
        );
        if (!file)
          throw invalid([
            {
              field: `attachmentIds[${i}]`,
              code: FieldErrorCode.FILE_NOT_AVAILABLE,
            },
          ]);
        await this.files.attach(tx, file);
        await tx.governanceBoardAppealAttachment.create({
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
        action: 'governance_board_appeal.lodged',
        targetId: id,
        changes: diffChanges(
          null,
          {
            number: appeal.number,
            kind: input.kind,
            subjectId: input.subjectId,
            unitId: resolved.unitId,
            decisionAt: resolved.decidedAt,
            deadlineAt: appeal.deadlineAt,
            attachments: ids.length,
            grounds: input.grounds,
          },
          'governance_board_appeal.lodged',
        ),
      });
      await this.notices.send(
        tx,
        await this.board.seatedAccounts(tx, now),
        'governance_appeal.lodged',
        id,
        { kind: input.kind },
      );
      return this.load(tx, appeal, true);
    });
  }

  /** The appellant withdraws a pending appeal (the decision's mark closes). */
  withdraw(id: string): Promise<AppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, await dbNow(tx)),
      );
      await this.lockRow(tx, id);
      const appeal = await tx.governanceBoardAppeal.findUniqueOrThrow({
        where: { id },
      });
      if (appeal.appellantId !== this.ctx.accountId) {
        if (!(await this.visibleTo(tx, appeal))) throw appealNotFound();
        throw appError.forbidden(
          ErrorCode.BOARD_APPEAL_NOT_YOURS,
          'Only the appellant withdraws an appeal',
        );
      }
      if (appeal.status !== 'pending') throw notPending(appeal.status);
      const now = await dbNow(tx);
      const motionId = await this.motions.closeWithMatter(
        tx,
        'appeal',
        id,
        this.ctx.accountId,
        now,
      );
      await this.matters
        .appeal(appeal.kind as BoardAppealKind)
        ?.closed(tx, appeal.subjectId, 'withdrawn', now);
      const withdrawn = await tx.governanceBoardAppeal.update({
        where: { id },
        data: { status: 'withdrawn', withdrawnAt: now, effect: 'none' },
      });
      await this.audit.record(tx, {
        action: 'governance_board_appeal.withdrawn',
        targetId: id,
        metadata: { motionId },
      });
      return this.load(tx, withdrawn, true);
    });
  }

  /** The appeals of the caller's units and the caller's own, newest first. */
  ownersList(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<AppealRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const units = await this.community.appealUnits(tx, this.ctx.accountId);
      const limit = clampLimit(q.limit);
      const rows = await tx.governanceBoardAppeal.findMany({
        where: {
          AND: [
            {
              OR: [
                { unitId: { in: units } },
                { appellantId: this.ctx.accountId },
              ],
            },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: AppealRecord[] = [];
      for (const a of page.items) items.push(await this.load(tx, a, true));
      return { items, nextCursor: page.nextCursor };
    });
  }

  ownersGet(id: string): Promise<AppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const appeal = await tx.governanceBoardAppeal.findUnique({
        where: { id },
      });
      if (!appeal || !(await this.visibleTo(tx, appeal)))
        throw appealNotFound();
      return this.load(tx, appeal, true);
    });
  }

  // --------------------------------------------------------------------------
  // The management (a party: the decision and its reasons only)
  // --------------------------------------------------------------------------

  staffList(q: {
    status?: AppealStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<AppealRecord>> {
    return this.page(q, false);
  }

  staffGet(id: string): Promise<AppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.load(tx, await this.find(tx, id), false),
    );
  }

  /** The manager followed an overturn left to the management up, once. */
  followedUp(id: string): Promise<AppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.lockRow(tx, id);
      const appeal = await tx.governanceBoardAppeal.findUniqueOrThrow({
        where: { id },
      });
      if (
        appeal.status !== 'overturned' ||
        appeal.effect !== 'follow_up' ||
        appeal.followedUpAt
      )
        throw appError.conflict(
          ErrorCode.BOARD_APPEAL_NO_FOLLOW_UP,
          'No follow-up is due',
        );
      const done = await tx.governanceBoardAppeal.update({
        where: { id },
        data: {
          followedUpAt: await dbNow(tx),
          followedUpById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_board_appeal.followed_up',
        targetId: id,
      });
      return this.load(tx, done, false);
    });
  }

  // --------------------------------------------------------------------------
  // The board
  // --------------------------------------------------------------------------

  boardList(q: {
    status?: AppealStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<AppealRecord>> {
    return this.page(q, true);
  }

  boardGet(id: string): Promise<BoardAppealRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const appeal = await this.find(tx, id);
      return {
        ...(await this.load(tx, appeal, true)),
        motions: await this.motions.ofMatter(tx, 'appeal', id),
      };
    });
  }

  // --------------------------------------------------------------------------
  // In other transactions: the decision, the erasure, the sweep
  // --------------------------------------------------------------------------

  /** A carried motion decides it (its row locked): the domain applies an overturn. */
  private async decide(
    tx: TenantTxClient,
    ev: { matter: MatterRow; motion: BoardMotion; now: Date },
  ): Promise<void> {
    const appeal = await tx.governanceBoardAppeal.findUniqueOrThrow({
      where: { id: ev.matter.id },
    });
    const outcome = ev.motion.outcome === 'overturn' ? 'overturned' : 'upheld';
    const handler = this.matters.appeal(appeal.kind as BoardAppealKind);
    const effect: AppealEffect = handler
      ? (await handler.closed(tx, appeal.subjectId, outcome, ev.now)).effect
      : outcome === 'overturned'
        ? 'follow_up'
        : 'none';
    await tx.governanceBoardAppeal.update({
      where: { id: appeal.id },
      data: {
        status: outcome,
        decidedAt: ev.now,
        decidedMotionId: ev.motion.id,
        effect,
      },
    });
    await this.audit.record(tx, {
      action: 'governance_board_appeal.decided',
      targetId: appeal.id,
      metadata: { outcome, motionId: ev.motion.id, effect },
    });
    await this.notices.send(
      tx,
      [
        ...(await this.told(tx, appeal.id)),
        ...(await this.board.seatedAccounts(tx, ev.now)),
      ],
      'governance_appeal.decided',
      appeal.id,
      { kind: appeal.kind, outcome },
    );
  }

  /**
   * An erasure (the account's row held): its appeals' grounds go, once,
   * and their attachments' files are marked deleted.
   */
  async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM governance_board_appeals
       WHERE appellant_account_id = ${accountId}::uuid AND grounds_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      await tx.governanceBoardAppeal.update({
        where: { id },
        data: { grounds: null, groundsClearedAt: now },
      });
      const attached = await tx.governanceBoardAppealAttachment.findMany({
        where: { appealId: id },
      });
      let deleted = 0;
      for (const a of attached) {
        const file = await tx.storedFile.findUnique({
          where: { id: a.fileId },
          select: { id: true, purpose: true },
        });
        if (file && (await this.files.markDeleted(tx, file, 'erasure')))
          deleted++;
      }
      await this.audit.record(tx, {
        action: 'governance_board_appeal.grounds_cleared',
        targetId: id,
        metadata: { attachments: deleted },
      });
    }
  }

  async overdueDue(tx: TenantTxClient, now: Date): Promise<string[]> {
    return (
      await tx.governanceBoardAppeal.findMany({
        where: {
          status: 'pending',
          overdueNotifiedAt: null,
          deadlineAt: { lte: now },
        },
        orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
        take: 50,
        select: { id: true },
      })
    ).map((a) => a.id);
  }

  /** Once: the board and the manager; the accounts first, the row SKIP LOCKED. */
  async notifyOverdue(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<number> {
    const told = [
      ...(await this.board.seatedAccounts(tx, now)),
      ...(await this.staff.holding(tx, 'governance.manage')).map((m) => m.id),
    ];
    await this.access.lockAccounts(tx, told);
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM governance_board_appeals
       WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
    if (!row) return 0;
    const { count } = await tx.governanceBoardAppeal.updateMany({
      where: {
        id,
        status: 'pending',
        overdueNotifiedAt: null,
        deadlineAt: { lte: now },
      },
      data: { overdueNotifiedAt: now },
    });
    if (!count) return 0;
    const appeal = await tx.governanceBoardAppeal.findUniqueOrThrow({
      where: { id },
    });
    await this.notices.send(tx, told, 'governance_appeal.overdue', id, {
      kind: appeal.kind,
    });
    return 1;
  }

  // --------------------------------------------------------------------------

  /** The appellant and the manager: who a decision tells besides the board. */
  private async told(tx: TenantTxClient, id: string): Promise<string[]> {
    const appeal = await tx.governanceBoardAppeal.findUnique({
      where: { id },
      select: { appellantId: true },
    });
    const managers = await this.staff.holding(tx, 'governance.manage');
    return [
      ...(appeal ? [appeal.appellantId] : []),
      ...managers.map((m) => m.id),
    ];
  }

  /** Everyone living in or owning the unit now, and the appellant. */
  private async recusals(tx: TenantTxClient, id: string): Promise<string[]> {
    const appeal = await tx.governanceBoardAppeal.findUniqueOrThrow({
      where: { id },
    });
    return [
      ...new Set([
        ...(await this.community.unitPeople(tx, appeal.unitId)),
        appeal.appellantId,
      ]),
    ].sort();
  }

  private async visibleTo(
    tx: TenantTxClient,
    appeal: GovernanceBoardAppeal,
  ): Promise<boolean> {
    return (
      appeal.appellantId === this.ctx.accountId ||
      (await this.community.mayAppealFor(tx, this.ctx.accountId, appeal.unitId))
    );
  }

  private async lockRow(tx: TenantTxClient, id: string): Promise<MatterRow> {
    const [row] = await tx.$queryRaw<
      { id: string; status: string; deadline_at: Date }[]
    >`
      SELECT id, status, deadline_at FROM governance_board_appeals
       WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw appealNotFound();
    return { id: row.id, status: row.status, deadlineAt: row.deadline_at };
  }

  private async find(
    tx: TenantTxClient,
    id: string,
  ): Promise<GovernanceBoardAppeal> {
    const appeal = await tx.governanceBoardAppeal.findUnique({ where: { id } });
    if (!appeal) throw appealNotFound();
    return appeal;
  }

  private page(
    q: { status?: AppealStatus; cursor?: string; limit?: number },
    withAttachments: boolean,
  ): Promise<Page<AppealRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.governanceBoardAppeal.findMany({
        where: {
          AND: [q.status ? { status: q.status } : {}, ...PAGE.after(q.cursor)],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: AppealRecord[] = [];
      for (const a of page.items)
        items.push(await this.load(tx, a, withAttachments));
      return { items, nextCursor: page.nextCursor };
    });
  }

  private async load(
    tx: TenantTxClient,
    appeal: GovernanceBoardAppeal,
    withAttachments: boolean,
  ): Promise<AppealRecord> {
    const codes = await this.community.unitCodes(tx, [appeal.unitId]);
    const decision = appeal.decidedMotionId
      ? await tx.boardMotion.findUnique({
          where: { id: appeal.decidedMotionId },
        })
      : null;
    const attachments: AppealRecord['attachments'] = [];
    if (withAttachments)
      for (const a of await tx.governanceBoardAppealAttachment.findMany({
        where: { appealId: appeal.id },
        orderBy: { position: 'asc' },
      }))
        attachments.push({
          fileId: a.fileId,
          url: (await this.files.readUrl(tx, a.fileId))?.url ?? null,
        });
    const handler = this.matters.appeal(appeal.kind as BoardAppealKind);
    return {
      appeal,
      unitCode: codes.get(appeal.unitId) ?? '',
      decision,
      subject: handler ? await handler.describe(tx, appeal.subjectId) : null,
      attachments,
      mine: appeal.appellantId === this.ctx.accountId,
      now: await dbNow(tx),
    };
  }
}
