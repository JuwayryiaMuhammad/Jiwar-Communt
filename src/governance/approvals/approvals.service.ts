import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  BoardMotion,
  GovernanceApprovalAlternative,
  GovernanceApprovalRequest,
} from '@prisma/client';
import { PermissionsService } from '../../core/access/permissions.service';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import {
  BoardMatters,
  type ApprovalType,
} from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { requireReasonCodeOnly, REASON_CODES } from '../../core/common/reasons';
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
import { BoardPublicationsService } from '../publications/publications.service';
import { GovernanceSettingsService } from '../settings/governance-settings.service';
import {
  SUBJECT_TYPES,
  THRESHOLD_TYPES,
  type ApprovalFilter,
} from './approval-rules';
import { ApprovalView } from './views/approvals.views';

export const GOVERNANCE_APPROVAL_RESOURCE = 'governance_approval';
const PAGE = keysetCursor('createdAt', 'desc');
const DAY = 86_400_000;

export interface NewApproval {
  type: ApprovalType;
  budgetId?: string;
  budgetLineId?: string;
  context: string;
  impact: string;
  cost?: string;
  alternatives?: { text: string; cost?: string }[];
  attachmentIds?: string[];
}

/** A request with what every view of it needs. */
export interface ApprovalRecord {
  request: GovernanceApprovalRequest;
  alternatives: GovernanceApprovalAlternative[];
  attachments: { fileId: string; url: string | null }[];
  /** The carried motion's reasons, once decided. */
  decision: BoardMotion | null;
  /** The type's threshold now, for the four thresholded types. */
  threshold: string | null;
  raisedByMe: boolean;
  /** The database's clock at the read: what `overdue` is judged by. */
  now: Date;
}

/** The board's view adds the subject and the deliberation. */
export interface BoardApprovalRecord extends ApprovalRecord {
  subject: unknown;
  motions: MotionRecord[];
}

const approvalNotFound = () =>
  appError.notFound(ErrorCode.APPROVAL_NOT_FOUND, 'Approval request not found');

const notPending = (status: string) =>
  appError.conflict(
    ErrorCode.APPROVAL_NOT_PENDING,
    'The request was decided or withdrawn already',
    { params: { status } },
  );

/**
 * Approval requests (ADR 0055): the manager or the accountant puts a
 * decision package to the board; the board decides it by a carried motion
 * (MotionsService), and what the decision does is the type's handler's,
 * registered by its domain with core's BoardMatters (an annual budget, an
 * increase, a contract's expense authorization). The manager marks an
 * approved request implemented when its decision did not.
 *
 * Who sees what: the staff (`governance.approvals`) read the package, its
 * status and the decision with its reasons; only the board reads the
 * motions, the votes and the counts.
 */
@Injectable()
export class ApprovalsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly permissions: PermissionsService,
    private readonly board: BoardService,
    private readonly motions: MotionsService,
    private readonly matters: BoardMatters,
    private readonly settings: GovernanceSettingsService,
    private readonly publications: BoardPublicationsService,
    private readonly staff: StaffRecipients,
    private readonly files: FilesService,
    private readonly notices: GovernanceNotices,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(GOVERNANCE_APPROVAL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        ApprovalView.from(
          await this.load(
            tx,
            await tx.governanceApprovalRequest.findUniqueOrThrow({
              where: { id },
            }),
          ),
        ),
      ),
    );
    this.motions.register({
      name: 'approval',
      outcomes: ['approve', 'reject'],
      told: (tx, id) => this.told(tx, id),
      lock: (tx, id) => this.lockRow(tx, id),
      lockSkip: async (tx, id) =>
        (
          await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM governance_approval_requests
             WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`
        ).length > 0,
      decide: (tx, ev) => this.decide(tx, ev),
    });
  }

  // --------------------------------------------------------------------------
  // The staff: raise, withdraw, implemented
  // --------------------------------------------------------------------------

  raise(input: NewApproval): Promise<ApprovalRecord> {
    const fields = packageProblems(input);
    if (fields.length) throw invalid(fields);
    const subjectId = input.budgetId ?? input.budgetLineId ?? null;
    const handler = this.matters.approval(input.type);
    if (SUBJECT_TYPES.includes(input.type) && !handler)
      throw new Error(`No handler is registered for ${input.type}`);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // Accounts first: the board it tells.
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, await dbNow(tx)),
      );
      const id = newId();
      await this.idempotency.claim(tx, {
        type: GOVERNANCE_APPROVAL_RESOURCE,
        id,
      });
      // The subject, locked and judged by its domain: a budget's total is
      // its cost.
      const cost = handler
        ? (
            await handler.raise(tx, {
              requestId: id,
              subjectId,
              cost: input.cost ?? null,
            })
          ).cost
        : (input.cost ?? null);
      // One pending request per subject, decided under the subject's lock.
      if (
        subjectId &&
        (await tx.governanceApprovalRequest.findFirst({
          where: { type: input.type, subjectId, status: 'pending' },
          select: { id: true },
        }))
      )
        throw appError.conflict(
          ErrorCode.DUPLICATE_RESOURCE,
          'A request about this is pending already',
          {
            fields: [
              {
                field: input.budgetId ? 'budgetId' : 'budgetLineId',
                code: FieldErrorCode.DUPLICATE_VALUE,
              },
            ],
          },
        );
      const days = await this.settings.deadlineDays(tx, input.type);
      const now = await dbNow(tx);
      const request = await tx.governanceApprovalRequest.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number: await nextGovernanceNumber(
            tx,
            this.ctx.txTenantId,
            'approval',
          ),
          type: input.type,
          subjectId,
          raisedById: this.ctx.accountId,
          context: input.context,
          impact: input.impact,
          cost,
          deadlineAt: new Date(now.getTime() + days * DAY),
          createdAt: now,
        },
      });
      const alternatives = input.alternatives ?? [];
      if (alternatives.length)
        await tx.governanceApprovalAlternative.createMany({
          data: alternatives.map((a, i) => ({
            tenantId: this.ctx.txTenantId,
            requestId: id,
            position: i + 1,
            text: a.text,
            cost: a.cost ?? null,
          })),
        });
      const attachmentIds = input.attachmentIds ?? [];
      for (const [i, fileId] of attachmentIds.entries()) {
        const file = await this.files.claim(tx, fileId, 'approval_attachment');
        if (!file)
          throw invalid([
            {
              field: `attachmentIds[${i}]`,
              code: FieldErrorCode.FILE_NOT_AVAILABLE,
            },
          ]);
        await this.files.attach(tx, file);
        await tx.governanceApprovalAttachment.create({
          data: {
            tenantId: this.ctx.txTenantId,
            requestId: id,
            fileId,
            position: i + 1,
          },
        });
      }
      await this.audit.record(tx, {
        action: 'governance_approval.raised',
        targetId: id,
        changes: diffChanges(
          null,
          {
            number: request.number,
            type: request.type,
            subjectId,
            cost: request.cost?.toFixed(2) ?? null,
            deadlineAt: request.deadlineAt,
            alternatives: alternatives.length,
            attachments: attachmentIds.length,
            context: input.context,
            impact: input.impact,
          },
          'governance_approval.raised',
        ),
      });
      await this.notices.send(
        tx,
        await this.board.seatedAccounts(tx, now),
        'governance_approval.raised',
        id,
        { type: request.type },
      );
      return this.load(tx, request);
    });
  }

  /** Who raised it, or the manager, withdraws a pending request. */
  withdraw(
    id: string,
    reasonCode: string | undefined,
  ): Promise<ApprovalRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.approvalWithdraw,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, await dbNow(tx)),
      );
      const row = await this.lockRow(tx, id);
      const request = await tx.governanceApprovalRequest.findUniqueOrThrow({
        where: { id: row.id },
      });
      if (request.status !== 'pending') throw notPending(request.status);
      const manager = await this.permissions.has('governance.manage');
      if (request.raisedById !== this.ctx.accountId && !manager)
        throw appError.forbidden(
          ErrorCode.APPROVAL_NOT_YOURS,
          'Only who raised it, or the manager, withdraws a request',
        );
      const now = await dbNow(tx);
      const motionId = await this.motions.closeWithMatter(
        tx,
        'approval',
        id,
        this.ctx.accountId,
        now,
      );
      await this.matters.approval(request.type as ApprovalType)?.withdrawn(tx, {
        requestId: id,
        subjectId: request.subjectId,
        now,
      });
      const withdrawn = await tx.governanceApprovalRequest.update({
        where: { id },
        data: {
          status: 'withdrawn',
          withdrawnAt: now,
          withdrawnById: this.ctx.accountId,
          withdrawReasonCode: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_approval.withdrawn',
        targetId: id,
        metadata: {
          reasonCode: reason,
          side:
            request.raisedById === this.ctx.accountId ? 'raiser' : 'manager',
          motionId,
        },
      });
      await this.notices.send(
        tx,
        await this.board.seatedAccounts(tx, now),
        'governance_approval.withdrawn',
        id,
        { type: request.type },
      );
      return this.load(tx, withdrawn);
    });
  }

  /** The manager: an approved request was carried out, once. */
  implemented(id: string, note: string | undefined): Promise<ApprovalRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, await dbNow(tx)),
      );
      const row = await this.lockRow(tx, id);
      const request = await tx.governanceApprovalRequest.findUniqueOrThrow({
        where: { id: row.id },
      });
      if (request.status !== 'approved')
        throw appError.conflict(
          ErrorCode.APPROVAL_NOT_APPROVED,
          'Only an approved request is implemented',
          { params: { status: request.status } },
        );
      if (request.implementedAt)
        throw appError.conflict(
          ErrorCode.APPROVAL_ALREADY_IMPLEMENTED,
          'The request is implemented already',
        );
      const now = await dbNow(tx);
      const done = await tx.governanceApprovalRequest.update({
        where: { id },
        data: {
          implementedAt: now,
          implementedById: this.ctx.accountId,
          implementationNote: note ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_approval.implemented',
        targetId: id,
        metadata: { note: Boolean(note) },
      });
      await this.notices.send(
        tx,
        await this.board.seatedAccounts(tx, now),
        'governance_approval.implemented',
        id,
        { type: request.type },
      );
      return this.load(tx, done);
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  list(q: {
    status?: ApprovalFilter;
    type?: ApprovalType;
    overdue?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ApprovalRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const limit = clampLimit(q.limit);
      const rows = await tx.governanceApprovalRequest.findMany({
        where: {
          AND: [
            filterWhere(q.status),
            q.type ? { type: q.type } : {},
            q.overdue ? { status: 'pending', deadlineAt: { lte: now } } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: ApprovalRecord[] = [];
      for (const r of page.items) items.push(await this.load(tx, r));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<ApprovalRecord> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.load(tx, await this.find(tx, id)),
    );
  }

  /** The board's: the package, its subject, every motion and vote. */
  boardGet(id: string): Promise<BoardApprovalRecord> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.loadForBoard(tx, await this.find(tx, id)),
    );
  }

  // --------------------------------------------------------------------------
  // The decision, in the deciding vote's transaction (its row locked)
  // --------------------------------------------------------------------------

  private async decide(
    tx: TenantTxClient,
    ev: { matter: MatterRow; motion: BoardMotion; now: Date },
  ): Promise<void> {
    const request = await tx.governanceApprovalRequest.findUniqueOrThrow({
      where: { id: ev.matter.id },
    });
    const approved = ev.motion.outcome === 'approve';
    const decision = approved ? 'approved' : 'rejected';
    const handler = this.matters.approval(request.type as ApprovalType);
    const applied = handler
      ? await handler.decided(tx, {
          requestId: request.id,
          subjectId: request.subjectId,
          cost: request.cost?.toFixed(2) ?? null,
          approved,
          now: ev.now,
        })
      : { implemented: false };
    await tx.governanceApprovalRequest.update({
      where: { id: request.id },
      data: {
        status: decision,
        decidedAt: ev.now,
        decidedMotionId: ev.motion.id,
        ...(approved && applied.implemented ? { implementedAt: ev.now } : {}),
      },
    });
    const announcementId =
      approved && applied.notice
        ? await this.publications.publishDecision(
            tx,
            applied.notice,
            ev.motion.termId,
            ev.now,
          )
        : null;
    await this.audit.record(tx, {
      action: 'governance_approval.decided',
      targetId: request.id,
      metadata: {
        decision,
        motionId: ev.motion.id,
        implemented: approved && applied.implemented,
        announcementId,
      },
    });
    await this.notices.send(
      tx,
      [
        ...(await this.told(tx, request.id)),
        ...(await this.board.seatedAccounts(tx, ev.now)),
      ],
      'governance_approval.decided',
      request.id,
      { type: request.type, decision },
    );
  }

  /** Who a decision tells besides the board: who raised it, and the manager. */
  private async told(tx: TenantTxClient, id: string): Promise<string[]> {
    const request = await tx.governanceApprovalRequest.findUnique({
      where: { id },
      select: { raisedById: true },
    });
    const managers = await this.staff.holding(tx, 'governance.manage');
    return [
      ...(request ? [request.raisedById] : []),
      ...managers.map((m) => m.id),
    ];
  }

  /** The overdue sweep: due requests, then one per transaction. */
  async overdueDue(tx: TenantTxClient, now: Date): Promise<string[]> {
    return (
      await tx.governanceApprovalRequest.findMany({
        where: {
          status: 'pending',
          overdueNotifiedAt: null,
          deadlineAt: { lte: now },
        },
        orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
        take: 50,
        select: { id: true },
      })
    ).map((r) => r.id);
  }

  /**
   * Tells the board and the manager once that a request is overdue: the
   * accounts first, then the row SKIP LOCKED (a vote in flight holds it),
   * then "once" claimed by a conditional update.
   */
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
      SELECT id FROM governance_approval_requests
       WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
    if (!row) return 0;
    const { count } = await tx.governanceApprovalRequest.updateMany({
      where: {
        id,
        status: 'pending',
        overdueNotifiedAt: null,
        deadlineAt: { lte: now },
      },
      data: { overdueNotifiedAt: now },
    });
    if (!count) return 0;
    const request = await tx.governanceApprovalRequest.findUniqueOrThrow({
      where: { id },
    });
    await this.notices.send(tx, told, 'governance_approval.overdue', id, {
      type: request.type,
    });
    return 1;
  }

  // --------------------------------------------------------------------------

  private async lockRow(tx: TenantTxClient, id: string): Promise<MatterRow> {
    const [row] = await tx.$queryRaw<
      { id: string; status: string; deadline_at: Date }[]
    >`
      SELECT id, status, deadline_at FROM governance_approval_requests
       WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw approvalNotFound();
    return { id: row.id, status: row.status, deadlineAt: row.deadline_at };
  }

  private async find(
    tx: TenantTxClient,
    id: string,
  ): Promise<GovernanceApprovalRequest> {
    const request = await tx.governanceApprovalRequest.findUnique({
      where: { id },
    });
    if (!request) throw approvalNotFound();
    return request;
  }

  private async load(
    tx: TenantTxClient,
    request: GovernanceApprovalRequest,
  ): Promise<ApprovalRecord> {
    // One query at a time: a transaction is one connection.
    const alternatives = await tx.governanceApprovalAlternative.findMany({
      where: { requestId: request.id },
      orderBy: { position: 'asc' },
    });
    const attached = await tx.governanceApprovalAttachment.findMany({
      where: { requestId: request.id },
      orderBy: { position: 'asc' },
    });
    const decision = request.decidedMotionId
      ? await tx.boardMotion.findUnique({
          where: { id: request.decidedMotionId },
        })
      : null;
    const attachments: ApprovalRecord['attachments'] = [];
    for (const a of attached)
      attachments.push({
        fileId: a.fileId,
        url: (await this.files.readUrl(tx, a.fileId))?.url ?? null,
      });
    const threshold = (THRESHOLD_TYPES as readonly string[]).includes(
      request.type,
    )
      ? await this.plainThreshold(tx, request.type)
      : null;
    return {
      request,
      alternatives,
      attachments,
      decision,
      threshold,
      raisedByMe: request.raisedById === this.ctx.accountId,
      now: await dbNow(tx),
    };
  }

  private async loadForBoard(
    tx: TenantTxClient,
    request: GovernanceApprovalRequest,
  ): Promise<BoardApprovalRecord> {
    const handler = this.matters.approval(request.type as ApprovalType);
    return {
      ...(await this.load(tx, request)),
      subject: handler ? await handler.describe(tx, request.subjectId) : null,
      motions: await this.motions.ofMatter(tx, 'approval', request.id),
    };
  }

  private async plainThreshold(
    tx: TenantTxClient,
    type: string,
  ): Promise<string | null> {
    const row = await tx.governanceApprovalSetting.findUnique({
      where: { tenantId_type: { tenantId: this.ctx.txTenantId, type } },
    });
    return row?.threshold ? row.threshold.toFixed(2) : null;
  }
}

/** What the lists filter by: `approved` is what waits to be implemented. */
function filterWhere(status: ApprovalFilter | undefined) {
  switch (status) {
    case undefined:
      return {};
    case 'approved':
      return { status: 'approved', implementedAt: null };
    case 'implemented':
      return { status: 'approved', implementedAt: { not: null } };
    default:
      return { status };
  }
}

/** The package's shape by its type, before any lock. */
function packageProblems(input: NewApproval): FieldError[] {
  const fields: FieldError[] = [];
  const subject = {
    annual_budget: 'budgetId',
    budget_increase: 'budgetLineId',
  } as Partial<Record<ApprovalType, 'budgetId' | 'budgetLineId'>>;
  const wanted = subject[input.type];
  for (const field of ['budgetId', 'budgetLineId'] as const) {
    if (field === wanted && !input[field])
      fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
    if (field !== wanted && input[field])
      fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
  }
  // An annual budget's cost is its total; an increase and a contract name one.
  if (input.type === 'annual_budget' && input.cost !== undefined)
    fields.push({ field: 'cost', code: FieldErrorCode.FIELD_NOT_ALLOWED });
  if (
    (input.type === 'budget_increase' || input.type === 'major_contract') &&
    input.cost === undefined
  )
    fields.push({ field: 'cost', code: FieldErrorCode.FIELD_REQUIRED });
  const ids = input.attachmentIds ?? [];
  if (new Set(ids).size !== ids.length)
    fields.push({
      field: 'attachmentIds',
      code: FieldErrorCode.DUPLICATE_VALUE,
    });
  return fields;
}
