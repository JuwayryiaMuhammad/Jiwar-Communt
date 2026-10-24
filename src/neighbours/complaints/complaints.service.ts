import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  NeighbourComplaint,
  NeighbourComplaintCategory,
  NeighbourComplaintStatus,
  NeighbourComplaintStatusChange,
  Prisma,
} from '@prisma/client';
import { CommunityNeighboursPort, type NeighbourUnit } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { NeighbourSettingsService } from '../settings/neighbour-settings.service';
import { ComplaintAccess } from './complaint-access';
import {
  ComplaintMessagesService,
  type Sender,
} from './complaint-messages.service';
import { ComplaintNotices } from './complaint-notices';
import { OPEN_STATUSES } from './complaint-rules';
import { ComplaintCreatedView } from './views/complaint.views';

export const COMPLAINT_RESOURCE = 'neighbour_complaint';
export const UNIT_CODE_LENGTH = { min: 1, max: 32 } as const;

export interface NewComplaint {
  categoryId: string;
  /** The unit complained about, by the code on its door. */
  targetUnitCode: string;
  /** One of the author's own units, when they have several. */
  unitId?: string;
  body: string;
  attachmentFileIds?: string[];
}

export interface ComplaintsQuery {
  cursor?: string;
  limit?: number;
  status?: NeighbourComplaintStatus;
  /** `'true'`: not resolved and not dismissed. */
  open?: 'true' | 'false';
}

export interface StaffComplaintsQuery extends ComplaintsQuery {
  categoryId?: string;
  targetUnitId?: string;
  authorId?: string;
}

/** A complaint with what names it: its category and its two units. */
export interface ComplaintRead {
  complaint: NeighbourComplaint;
  category: NeighbourComplaintCategory;
  targetUnit: NeighbourUnit;
  authorUnit: NeighbourUnit | null;
}

/** How many complaints there are against a unit, for the staff. */
export interface UnitTally {
  total: number;
  open: number;
}

export interface StaffComplaintRead extends ComplaintRead {
  author: Sender;
  againstUnit: UnitTally;
}

export interface HistoryRead {
  change: NeighbourComplaintStatusChange;
  actor: Sender;
}

export interface NoticeFacts {
  id: string;
  body: string;
  recipientKind: 'household' | 'owners';
  createdAt: Date;
  /** Withdrawn by an overturned decision appeal (ADR 0059). */
  withdrawnAt: Date | null;
  sentBy: Sender;
  recipients: Sender[];
}

/** What the staff see of a unit's past, and of an author's habits. */
export interface UnitHistory extends UnitTally {
  resolved: number;
  dismissed: number;
  unfounded: number;
}

export interface AuthorPattern {
  total: number;
  open: number;
  dismissedUnfounded: number;
  againstSameUnit: number;
}

export interface StaffComplaintDetail extends StaffComplaintRead {
  history: HistoryRead[];
  notice: NoticeFacts | null;
  unitHistory: UnitHistory;
  authorPattern: AuthorPattern;
}

export interface ComplaintDetail extends ComplaintRead {
  history: NeighbourComplaintStatusChange[];
}

/** The most recently active first. */
const PAGE = keysetCursor('lastActivityAt');
const SENDER = { select: { id: true, fullName: true, status: true } } as const;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid complaint', {
    fields,
  });

/**
 * Complaints against a unit (ADR 0042): filing one and reading them per
 * audience. What happens on a complaint afterwards lives in the status,
 * messages and notice services; every one of them locks the complaint and
 * asks complaint-rules first.
 */
@Injectable()
export class ComplaintsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly access: ComplaintAccess,
    private readonly messages: ComplaintMessagesService,
    private readonly settings: NeighbourSettingsService,
    private readonly community: CommunityNeighboursPort,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notices: ComplaintNotices,
  ) {}

  onModuleInit(): void {
    // A replay whose stored body was lost renders the complaint as created.
    this.idempotency.renderer(COMPLAINT_RESOURCE, async (id) =>
      ComplaintCreatedView.from(
        await this.tenantTx.withTenantTx((tx) =>
          tx.neighbourComplaint.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /**
   * A resident complains about a unit, named by its code. Never their own:
   * any unit the author has a place in is refused the same way, whoever
   * lives in the other one, or nobody (the author learns nothing of it).
   *
   * The compound's counter row serializes its new complaints until the
   * commit; under it the author's open complaints are counted against the
   * compound's limit, so two filings at once cannot both be the last one
   * allowed. A refusal rolls the number back.
   */
  create(input: NewComplaint): Promise<NeighbourComplaint> {
    const me = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const body = this.messages.body(input.body);
    const fileIds = this.messages.fileIds(input.attachmentFileIds);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: COMPLAINT_RESOURCE, id });
      await this.self.lockSelf(tx);
      const places = await this.community.places(tx, me);
      if (!places.length)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only someone with a unit in the compound files a complaint',
        );
      if (input.unitId && !places.some((p) => p.id === input.unitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const authorUnitId =
        input.unitId ?? (places.length === 1 ? places[0].id : null);
      const target = await this.community.unitByCode(tx, input.targetUnitCode);
      if (!target)
        throw invalid([
          { field: 'targetUnitCode', code: FieldErrorCode.UNIT_CODE_UNKNOWN },
        ]);
      if (places.some((p) => p.id === target.id))
        throw invalid([
          { field: 'targetUnitCode', code: FieldErrorCode.OWN_UNIT },
        ]);
      const category = await tx.neighbourComplaintCategory.findFirst({
        where: { id: input.categoryId, active: true },
      });
      if (!category)
        throw invalid([
          { field: 'categoryId', code: FieldErrorCode.CATEGORY_NOT_AVAILABLE },
        ]);
      const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
        INSERT INTO neighbour_complaint_counters (tenant_id, last_number)
        VALUES (${tenantId}::uuid, 1)
        ON CONFLICT (tenant_id)
          DO UPDATE SET last_number = neighbour_complaint_counters.last_number + 1
        RETURNING last_number AS number`;
      const { maxOpenComplaints: max } = await this.settings.share(tx);
      const open = await tx.neighbourComplaint.count({
        where: { authorId: me, status: { in: [...OPEN_STATUSES] } },
      });
      if (open >= max)
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_COMPLAINT_LIMIT_REACHED,
          'Too many open complaints',
          { params: { max } },
        );
      const now = await dbNow(tx);
      const complaint = await tx.neighbourComplaint.create({
        data: {
          id,
          tenantId,
          number,
          authorId: me,
          authorUnitId,
          targetUnitId: target.id,
          categoryId: category.id,
          lastActivityAt: now,
          createdAt: now,
        },
      });
      await tx.neighbourComplaintStatusChange.create({
        data: {
          id: newId(),
          tenantId,
          complaintId: id,
          fromStatus: null,
          toStatus: 'submitted',
          actorId: me,
          actorSide: 'resident',
          createdAt: now,
        },
      });
      const message = await this.messages.write(
        tx,
        complaint,
        { thread: 'complainant', side: 'resident', body },
        now,
      );
      await this.messages.attach(tx, message, fileIds, 'attachmentFileIds');
      await this.audit.record(tx, {
        action: 'neighbour_complaint.created',
        targetId: complaint.id,
        metadata: {
          complaintNumber: complaint.number,
          categoryKey: category.key,
          targetUnitId: target.id,
          withUnit: authorUnitId !== null,
        },
      });
      await this.notices.toHandlers(
        tx,
        complaint,
        'neighbour_complaint.submitted',
      );
      return complaint;
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  /**
   * The caller's own complaints, the most recently active first. Activity
   * moves a complaint up, so one that changes between two pages may be
   * seen twice or not at all: a list to look at, never to count with.
   */
  listMine(q: ComplaintsQuery): Promise<Page<ComplaintRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const page = await this.rows(
        tx,
        { authorId: this.ctx.accountId, ...this.byStatus(q) },
        q,
      );
      return { ...page, items: await this.named(tx, page.items) };
    });
  }

  /** One of the caller's own complaints, with every status it has had. */
  detail(id: string): Promise<ComplaintDetail> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const complaint = await this.access.load(tx, id, 'author');
      const [read] = await this.named(tx, [complaint]);
      const history = await tx.neighbourComplaintStatusChange.findMany({
        where: { complaintId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return { ...read, history };
    });
  }

  /** The compound's complaints, for the staff inbox. */
  listForStaff(q: StaffComplaintsQuery): Promise<Page<StaffComplaintRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const page = await this.rows(
        tx,
        {
          AND: [
            this.byStatus(q),
            q.categoryId ? { categoryId: q.categoryId } : {},
            q.targetUnitId ? { targetUnitId: q.targetUnitId } : {},
            q.authorId ? { authorId: q.authorId } : {},
          ],
        },
        q,
      );
      return { ...page, items: await this.forStaff(tx, page.items) };
    });
  }

  /**
   * A complaint as the staff work it: who filed it, every move, the notice
   * and who it went to, what there has been against the unit before, and
   * how its author files. None of the last two is ever a resident's to see.
   */
  detailForStaff(id: string): Promise<StaffComplaintDetail> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const complaint = await this.access.load(tx, id, 'staff');
      const [read] = await this.forStaff(tx, [complaint]);
      const history = await tx.neighbourComplaintStatusChange.findMany({
        where: { complaintId: id },
        include: { actor: SENDER },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const notice = await tx.neighbourComplaintNotice.findFirst({
        where: { complaintId: id },
        include: {
          sentBy: SENDER,
          recipients: {
            include: { account: SENDER },
            orderBy: { accountId: 'asc' },
          },
        },
      });
      return {
        ...read,
        history: history.map(({ actor, ...change }) => ({ change, actor })),
        notice: notice && {
          id: notice.id,
          body: notice.body,
          recipientKind: notice.recipientKind,
          createdAt: notice.createdAt,
          withdrawnAt: notice.withdrawnAt,
          sentBy: notice.sentBy,
          recipients: notice.recipients.map((r) => r.account),
        },
        unitHistory: await this.unitTally(tx, complaint.targetUnitId),
        authorPattern: await this.authorPattern(tx, complaint),
      };
    });
  }

  /** What there has been against a unit: for the staff, never a resident. */
  unitHistory(
    unitId: string,
  ): Promise<{ unit: NeighbourUnit; history: UnitHistory }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const unit = await this.community.unit(tx, unitId);
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      return { unit, history: await this.unitTally(tx, unitId) };
    });
  }

  private byStatus(q: ComplaintsQuery): Prisma.NeighbourComplaintWhereInput {
    return {
      AND: [
        q.status ? { status: q.status } : {},
        q.open === 'true' ? { status: { in: [...OPEN_STATUSES] } } : {},
        q.open === 'false' ? { status: { notIn: [...OPEN_STATUSES] } } : {},
      ],
    };
  }

  private async rows(
    tx: TenantTxClient,
    where: Prisma.NeighbourComplaintWhereInput,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<NeighbourComplaint>> {
    const limit = clampLimit(q.limit);
    const rows = await tx.neighbourComplaint.findMany({
      where: { AND: [where, ...PAGE.after(q.cursor)] },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    return PAGE.toPage(rows, limit);
  }

  private async named(
    tx: TenantTxClient,
    complaints: NeighbourComplaint[],
  ): Promise<ComplaintRead[]> {
    if (!complaints.length) return [];
    const categories = new Map(
      (
        await tx.neighbourComplaintCategory.findMany({
          where: {
            id: { in: [...new Set(complaints.map((c) => c.categoryId))] },
          },
        })
      ).map((c) => [c.id, c]),
    );
    const units = await this.community.units(
      tx,
      complaints.flatMap((c) =>
        c.authorUnitId ? [c.targetUnitId, c.authorUnitId] : [c.targetUnitId],
      ),
    );
    return complaints.map((complaint) => ({
      complaint,
      category: categories.get(complaint.categoryId)!,
      targetUnit: units.get(complaint.targetUnitId)!,
      authorUnit: complaint.authorUnitId
        ? (units.get(complaint.authorUnitId) ?? null)
        : null,
    }));
  }

  private async forStaff(
    tx: TenantTxClient,
    complaints: NeighbourComplaint[],
  ): Promise<StaffComplaintRead[]> {
    if (!complaints.length) return [];
    const reads = await this.named(tx, complaints);
    const authors = new Map(
      (
        await tx.account.findMany({
          where: {
            id: { in: [...new Set(complaints.map((c) => c.authorId))] },
          },
          ...SENDER,
        })
      ).map((a) => [a.id, a]),
    );
    const unitIds = [...new Set(complaints.map((c) => c.targetUnitId))];
    const totals = await tx.neighbourComplaint.groupBy({
      by: ['targetUnitId'],
      where: { targetUnitId: { in: unitIds } },
      _count: { _all: true },
    });
    const opens = await tx.neighbourComplaint.groupBy({
      by: ['targetUnitId'],
      where: {
        targetUnitId: { in: unitIds },
        status: { in: [...OPEN_STATUSES] },
      },
      _count: { _all: true },
    });
    const total = new Map(totals.map((t) => [t.targetUnitId, t._count._all]));
    const open = new Map(opens.map((t) => [t.targetUnitId, t._count._all]));
    return reads.map((r) => ({
      ...r,
      author: authors.get(r.complaint.authorId)!,
      againstUnit: {
        total: total.get(r.complaint.targetUnitId) ?? 0,
        open: open.get(r.complaint.targetUnitId) ?? 0,
      },
    }));
  }

  private async unitTally(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<UnitHistory> {
    const rows = await tx.neighbourComplaint.groupBy({
      by: ['status', 'closeReason'],
      where: { targetUnitId: unitId },
      _count: { _all: true },
    });
    const sum = (keep: (r: (typeof rows)[number]) => boolean) =>
      rows.filter(keep).reduce((n, r) => n + r._count._all, 0);
    return {
      total: sum(() => true),
      open: sum((r) => OPEN_STATUSES.includes(r.status)),
      resolved: sum((r) => r.status === 'resolved'),
      dismissed: sum((r) => r.status === 'dismissed'),
      unfounded: sum((r) => r.closeReason === 'unfounded'),
    };
  }

  /** How this author files: for the staff's eyes only. */
  private async authorPattern(
    tx: TenantTxClient,
    complaint: Pick<NeighbourComplaint, 'authorId' | 'targetUnitId'>,
  ): Promise<AuthorPattern> {
    const where = { authorId: complaint.authorId };
    return {
      total: await tx.neighbourComplaint.count({ where }),
      open: await tx.neighbourComplaint.count({
        where: { ...where, status: { in: [...OPEN_STATUSES] } },
      }),
      dismissedUnfounded: await tx.neighbourComplaint.count({
        where: { ...where, closeReason: 'unfounded' },
      }),
      againstSameUnit: await tx.neighbourComplaint.count({
        where: { ...where, targetUnitId: complaint.targetUnitId },
      }),
    };
  }
}
