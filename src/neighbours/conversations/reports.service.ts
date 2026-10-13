import { Injectable } from '@nestjs/common';
import type {
  NeighbourConversation,
  NeighbourConversationMessage,
  NeighbourConversationReport,
  NeighbourPost,
  NeighbourReportStatus,
} from '@prisma/client';
import { CommunityNeighboursPort, type NeighbourUnit } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { BoardNotices } from '../posts/board-notices';
import { postState, type PostState } from '../posts/post-rules';
import { PostsService, type Person } from '../posts/posts.service';
import { conversationNotFound } from './conversations.service';
import { sideOf, type ConversationSide } from './masking';

export const REPORT_NOTE_LENGTH = { min: 1, max: 1000 } as const;

export interface NewReport {
  reasonCode: string;
  note?: string;
}

/** A report as the staff read it: the case, and who its two sides are. */
export interface ReportRead {
  report: NeighbourConversationReport;
  reporter: Person;
  reporterSide: ConversationSide;
  closedBy: Person | null;
  conversation: NeighbourConversation;
  author: Person;
  authorUnit: NeighbourUnit | null;
  responder: Person;
  responderUnit: NeighbourUnit | null;
  post: NeighbourPost;
  postState: PostState;
}

export interface ReportedMessageRead {
  message: NeighbourConversationMessage;
  sender: Person;
  side: ConversationSide;
}

/** Newest first. */
const LIST = keysetCursor('createdAt');
/** Oldest first: a conversation reads top to bottom. */
const THREAD = keysetCursor('createdAt', 'asc');
const PERSON = { select: { id: true, fullName: true, status: true } } as const;
const CASE = {
  reporter: PERSON,
  closedBy: PERSON,
  conversation: {
    include: { author: PERSON, responder: PERSON, post: true },
  },
} as const;

export const reportNotFound = () =>
  appError.notFound(ErrorCode.NEIGHBOUR_REPORT_NOT_FOUND, 'Report not found');

/**
 * Reported conversations (ADR 0042): the only way the staff ever read
 * what two residents wrote to each other. A participant reports one
 * conversation; that opens a case which shows the staff that conversation
 * and no other, with its two sides by name, while the case is open. Every
 * reading of it is audited. Once the case is closed the conversation is
 * sealed to the staff again.
 *
 * Reporting closes the conversation for both sides, with the same neutral
 * "closed" a blocked or expired one shows: the reported side is told
 * nothing.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly posts: PostsService,
    private readonly community: CommunityNeighboursPort,
    private readonly staff: StaffRecipients,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly boardNotices: BoardNotices,
  ) {}

  /** A participant reports their conversation, once. */
  report(
    conversationId: string,
    input: NewReport,
  ): Promise<NeighbourConversationReport> {
    const me = this.ctx.accountId;
    const reasonCode = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.neighbourConversationReport,
    );
    const note = input.note?.trim() || null;
    if (note !== null && note.length > REPORT_NOTE_LENGTH.max)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid report', {
        fields: [
          {
            field: 'note',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { ...REPORT_NOTE_LENGTH },
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM neighbour_conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
      const c = await tx.neighbourConversation.findUnique({
        where: { id: conversationId },
      });
      if (!c || sideOf(c, me) === null) throw conversationNotFound();
      if (
        await tx.neighbourConversationReport.count({
          where: { conversationId, reporterId: me },
        })
      )
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_REPORT_EXISTS,
          'You already reported this conversation',
        );
      const now = await dbNow(tx);
      const report = await tx.neighbourConversationReport.create({
        data: {
          id: newId(),
          tenantId: c.tenantId,
          conversationId,
          reporterId: me,
          reasonCode,
          note,
          createdAt: now,
        },
      });
      if (c.closedAt === null)
        await tx.neighbourConversation.update({
          where: { id: conversationId },
          data: { closedAt: now, closeReason: 'reported' },
        });
      await this.audit.record(tx, {
        action: 'neighbour_conversation.reported',
        targetId: conversationId,
        metadata: { reportId: report.id, reasonCode },
      });
      const handlers = await this.staff.holding(tx, 'neighbours.handle');
      await this.notifier.notify(
        tx,
        handlers.map((h) => h.id),
        {
          kind: 'neighbour_conversation.reported',
          params: {},
          targetId: report.id,
        },
      );
      return report;
    });
  }

  // --------------------------------------------------------------------------
  // The staff
  // --------------------------------------------------------------------------

  listForStaff(q: {
    cursor?: string;
    limit?: number;
    status?: NeighbourReportStatus;
  }): Promise<Page<ReportRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.neighbourConversationReport.findMany({
        where: {
          AND: [q.status ? { status: q.status } : {}, ...LIST.after(q.cursor)],
        },
        include: CASE,
        orderBy: LIST.orderBy,
        take: limit + 1,
      });
      const page = LIST.toPage(rows, limit);
      const now = await dbNow(tx);
      const items: ReportRead[] = [];
      for (const r of page.items) items.push(await this.read(tx, r, now));
      return { items, nextCursor: page.nextCursor };
    });
  }

  getForStaff(id: string): Promise<ReportRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const report = await tx.neighbourConversationReport.findUnique({
        where: { id },
        include: CASE,
      });
      if (!report) throw reportNotFound();
      return this.read(tx, report, await dbNow(tx));
    });
  }

  /**
   * The reported conversation, and only it, while the case is open. Each
   * reading is written to the audit trail: who read which case.
   */
  thread(
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<ReportedMessageRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const report = await tx.neighbourConversationReport.findUnique({
        where: { id },
        include: { conversation: true },
      });
      if (!report) throw reportNotFound();
      this.assertOpen(report);
      const limit = clampLimit(q.limit);
      const rows = await tx.neighbourConversationMessage.findMany({
        where: {
          AND: [
            { conversationId: report.conversationId },
            ...THREAD.after(q.cursor),
          ],
        },
        include: { sender: PERSON },
        orderBy: THREAD.orderBy,
        take: limit + 1,
      });
      const page = THREAD.toPage(rows, limit);
      await this.audit.record(tx, {
        action: 'neighbour_report.conversation_read',
        targetId: id,
        metadata: { conversationId: report.conversationId },
      });
      return {
        items: page.items.map(({ sender, ...message }) => ({
          message,
          sender,
          side: sideOf(report.conversation, message.senderId)!,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * The staff close the case with what they did. `post_removed` takes the
   * post down in the same transaction, if it is still up, and tells its
   * author as any removal does. The reporter is told the case was looked
   * at, and nothing of its outcome.
   */
  close(id: string, outcomeCode: string | undefined): Promise<void> {
    const outcome = requireReasonCodeOnly(
      outcomeCode,
      REASON_CODES.neighbourReportOutcome,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const found = await tx.neighbourConversationReport.findUnique({
        where: { id },
        include: { conversation: { select: { postId: true } } },
      });
      if (!found) throw reportNotFound();
      // The post before the report: the order every board write takes.
      if (outcome === 'post_removed')
        await this.posts.lock(tx, found.conversation.postId);
      await tx.$queryRaw`SELECT id FROM neighbour_conversation_reports WHERE id = ${id}::uuid FOR UPDATE`;
      const report = await tx.neighbourConversationReport.findUniqueOrThrow({
        where: { id },
      });
      this.assertOpen(report);
      const now = await dbNow(tx);
      await tx.neighbourConversationReport.update({
        where: { id },
        data: {
          status: 'closed',
          outcome,
          closedById: this.ctx.accountId,
          closedAt: now,
        },
      });
      let postRemoved = false;
      if (outcome === 'post_removed') {
        const post = await tx.neighbourPost.findUniqueOrThrow({
          where: { id: found.conversation.postId },
        });
        if (post.status === 'open') {
          await this.posts.end(
            tx,
            post,
            'inappropriate',
            now,
            'neighbour_post.removed',
            { reportId: id },
          );
          await this.boardNotices.to(
            tx,
            [post.authorId],
            post,
            'neighbour_post.removed',
          );
          postRemoved = true;
        }
      }
      await this.audit.record(tx, {
        action: 'neighbour_report.closed',
        targetId: id,
        metadata: {
          conversationId: report.conversationId,
          outcome,
          postRemoved: postRemoved ? 1 : 0,
        },
      });
      const reporter = await tx.account.count({
        where: { id: report.reporterId, status: 'active' },
      });
      if (reporter)
        await this.notifier.notify(tx, [report.reporterId], {
          kind: 'neighbour_report.closed',
          params: {},
          targetId: report.conversationId,
        });
    });
  }

  private assertOpen(
    report: Pick<NeighbourConversationReport, 'status'>,
  ): void {
    if (report.status !== 'open')
      throw appError.conflict(
        ErrorCode.NEIGHBOUR_REPORT_CLOSED,
        'The case is closed',
      );
  }

  private async read(
    tx: TenantTxClient,
    row: NeighbourConversationReport & {
      reporter: Person;
      closedBy: Person | null;
      conversation: NeighbourConversation & {
        author: Person;
        responder: Person;
        post: NeighbourPost;
      };
    },
    now: Date,
  ): Promise<ReportRead> {
    const { reporter, closedBy, conversation: full, ...report } = row;
    const { author, responder, post, ...conversation } = full;
    const units = await this.community.units(
      tx,
      [post.authorUnitId, conversation.responderUnitId].flatMap((u) => u ?? []),
    );
    return {
      report,
      reporter,
      reporterSide: sideOf(conversation, report.reporterId)!,
      closedBy,
      conversation,
      author,
      authorUnit: post.authorUnitId
        ? (units.get(post.authorUnitId) ?? null)
        : null,
      responder,
      responderUnit: conversation.responderUnitId
        ? (units.get(conversation.responderUnitId) ?? null)
        : null,
      post,
      postState: postState(post, now),
    };
  }
}
