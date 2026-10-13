import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  NeighbourComplaint,
  NeighbourComplaintMessage,
  NeighbourSide,
  NeighbourThread,
} from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { ComplaintAccess, type ComplaintAudience } from './complaint-access';
import { ComplaintNotices } from './complaint-notices';
import { assertCan, postAction } from './complaint-rules';

export const COMPLAINT_MESSAGE_RESOURCE = 'neighbour_complaint_message';
export const MESSAGE_LENGTH = { min: 1, max: 4000 } as const;
/** Photos and documents on one message. */
export const MAX_ATTACHMENTS = 5;

export interface PostedMessage {
  body: string;
  attachmentFileIds?: string[];
}

export interface Sender {
  id: string;
  fullName: string | null;
  status: string;
}

export interface AttachmentRead {
  id: string;
  contentType: string;
  /** Null when the file is gone. */
  read: PresignedRead | null;
}

export interface MessageRead {
  message: NeighbourComplaintMessage;
  sender: Sender;
  attachments: AttachmentRead[];
}

/** Oldest first: a conversation reads top to bottom. */
const PAGE = keysetCursor('createdAt', 'asc');

const invalid = (
  field: string,
  code: FieldErrorCode,
  params?: Record<string, number>,
) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid message', {
    fields: [{ field, code, ...(params ? { params } : {}) }],
  });

/**
 * A complaint's three conversations (ADR 0042), each private to its side
 * and the staff:
 * - `complainant`: the author and the staff, with the evidence;
 * - `target`: whoever the notice went to and the staff;
 * - `internal`: the staff's own notes.
 *
 * Every read names exactly one thread and filters on it in SQL, and
 * attachments are fetched only for the messages that read selected: no
 * route reads across two threads, and no view has a field that could say
 * another thread exists.
 *
 * A message is written once and never changes: the table's trigger refuses
 * everything but the erasure that clears its body. Bodies are content:
 * never audited, never in a notification.
 */
@Injectable()
export class ComplaintMessagesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly access: ComplaintAccess,
    private readonly files: FilesService,
    private readonly idempotency: IdempotencyService,
    private readonly notices: ComplaintNotices,
  ) {}

  onModuleInit(): void {
    // No body: the stored replay of a post holds no free text.
    this.idempotency.renderer(COMPLAINT_MESSAGE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const m = await tx.neighbourComplaintMessage.findUniqueOrThrow({
          where: { id },
        });
        return { id: m.id, createdAt: m.createdAt };
      }),
    );
  }

  /**
   * One thread as the author or the staff read it. The author has one
   * thread, their own; the staff name the one they open.
   */
  list(
    complaintId: string,
    audience: ComplaintAudience,
    thread: NeighbourThread,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<MessageRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, complaintId, audience);
      return this.read(
        tx,
        complaintId,
        audience === 'author' ? 'complainant' : thread,
        q,
      );
    });
  }

  /**
   * One thread of a complaint the caller was already allowed to read it
   * of. The thread is a WHERE, never a filter applied afterwards.
   */
  async read(
    tx: TenantTxClient,
    complaintId: string,
    thread: NeighbourThread,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<MessageRead>> {
    const limit = clampLimit(q.limit);
    const rows = await tx.neighbourComplaintMessage.findMany({
      where: { AND: [{ complaintId, thread }, ...PAGE.after(q.cursor)] },
      include: {
        sender: { select: { id: true, fullName: true, status: true } },
      },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    const page = PAGE.toPage(rows, limit);
    const attachments = await this.attachmentsOf(
      tx,
      complaintId,
      page.items.map((m) => m.id),
    );
    return {
      items: page.items.map(({ sender, ...message }) => ({
        message,
        sender,
        attachments: attachments.get(message.id) ?? [],
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * The attachments of exactly these messages, each with a read URL. The
   * caller chose the messages: a reader who may not see a message never
   * names it here.
   */
  private async attachmentsOf(
    tx: TenantTxClient,
    complaintId: string,
    messageIds: string[],
  ): Promise<Map<string, AttachmentRead[]>> {
    const out = new Map<string, AttachmentRead[]>();
    if (!messageIds.length) return out;
    const rows = await tx.neighbourComplaintAttachment.findMany({
      where: { complaintId, messageId: { in: messageIds } },
      include: { file: { select: { contentType: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const a of rows) {
      const list = out.get(a.messageId) ?? [];
      list.push({
        id: a.id,
        contentType: a.file.contentType,
        read: await this.files.readUrl(tx, a.fileId),
      });
      out.set(a.messageId, list);
    }
    return out;
  }

  /**
   * The author writes in their thread; the staff write in the one they
   * name. In the complainant's thread each side's message tells the other
   * and moves the complaint up both lists. A note moves nothing and tells
   * nobody. The unit's thread tells its own two sides and never moves the
   * complaint: its author must not see it stir when the unit answers.
   */
  post(
    complaintId: string,
    audience: ComplaintAudience,
    thread: NeighbourThread,
    input: PostedMessage,
  ): Promise<NeighbourComplaintMessage> {
    const body = this.body(input.body);
    const fileIds = this.fileIds(input.attachmentFileIds);
    const side: NeighbourSide = audience === 'author' ? 'resident' : 'staff';
    const into: NeighbourThread =
      audience === 'author' ? 'complainant' : thread;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: COMPLAINT_MESSAGE_RESOURCE,
        id,
      });
      await this.self.lockSelf(tx);
      const complaint = await this.access.load(tx, complaintId, audience, {
        lock: true,
      });
      assertCan(complaint, postAction(into));
      if (into === 'target') await this.requireNotice(tx, complaint.id);
      const now = await dbNow(tx);
      const message = await this.write(
        tx,
        complaint,
        { thread: into, side, body },
        now,
        id,
      );
      await this.attach(tx, message, fileIds, 'attachmentFileIds');
      if (into === 'complainant') {
        await tx.neighbourComplaint.update({
          where: { id: complaint.id },
          data: { lastActivityAt: now },
        });
        if (side === 'staff')
          await this.notices.toAuthor(
            tx,
            complaint,
            'neighbour_complaint.replied',
          );
        else
          await this.notices.toHandlers(
            tx,
            complaint,
            'neighbour_complaint.author_replied',
          );
      }
      return message;
    });
  }

  /** The unit's thread opens with its notice, never before. */
  async requireNotice(
    tx: TenantTxClient,
    complaintId: string,
  ): Promise<string> {
    const notice = await tx.neighbourComplaintNotice.findFirst({
      where: { complaintId },
      select: { id: true },
    });
    if (!notice)
      throw appError.conflict(
        ErrorCode.NEIGHBOUR_NOTICE_NOT_SENT,
        'The unit was not sent a notice',
      );
    return notice.id;
  }

  /** The trimmed body, or INVALID_LENGTH on `body`. */
  body(text: string): string {
    const body = text.trim();
    if (body.length < MESSAGE_LENGTH.min || body.length > MESSAGE_LENGTH.max)
      throw invalid('body', FieldErrorCode.INVALID_LENGTH, {
        ...MESSAGE_LENGTH,
      });
    return body;
  }

  /** At most MAX_ATTACHMENTS, each once. */
  fileIds(ids: readonly string[] | undefined): string[] {
    const unique = [...new Set(ids ?? [])];
    if (unique.length > MAX_ATTACHMENTS)
      throw invalid('attachmentFileIds', FieldErrorCode.INVALID_LENGTH, {
        min: 0,
        max: MAX_ATTACHMENTS,
      });
    return unique;
  }

  /**
   * Inside the caller's transaction, under the complaint's lock: the row,
   * by the caller, at `at` (the database's clock, read after the lock).
   */
  write(
    tx: TenantTxClient,
    complaint: Pick<NeighbourComplaint, 'id' | 'tenantId'>,
    message: { thread: NeighbourThread; side: NeighbourSide; body: string },
    at: Date,
    id = newId(),
  ): Promise<NeighbourComplaintMessage> {
    return tx.neighbourComplaintMessage.create({
      data: {
        id,
        tenantId: complaint.tenantId,
        complaintId: complaint.id,
        thread: message.thread,
        senderId: this.ctx.accountId,
        senderSide: message.side,
        body: message.body,
        createdAt: at,
      },
    });
  }

  /**
   * Moves the caller's own finalized `complaint_evidence` files to the
   * message: they no longer have an owner, so the uploader's erasure
   * leaves them (as a ticket's photos, ADR 0029). Anything else is
   * FILE_NOT_AVAILABLE on `<field>.<index>`.
   */
  async attach(
    tx: TenantTxClient,
    message: Pick<
      NeighbourComplaintMessage,
      'id' | 'tenantId' | 'complaintId' | 'createdAt'
    >,
    fileIds: readonly string[],
    field: string,
  ): Promise<void> {
    for (const [i, fileId] of fileIds.entries()) {
      const file = await this.files.claim(tx, fileId, 'complaint_evidence');
      if (!file)
        throw invalid(`${field}.${i}`, FieldErrorCode.FILE_NOT_AVAILABLE);
      await this.files.attach(tx, file);
      await tx.neighbourComplaintAttachment.create({
        data: {
          id: newId(),
          tenantId: message.tenantId,
          complaintId: message.complaintId,
          messageId: message.id,
          fileId: file.id,
          uploadedById: this.ctx.accountId,
          createdAt: message.createdAt,
        },
      });
    }
  }
}
