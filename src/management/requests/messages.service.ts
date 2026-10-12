import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  ManagementRequest,
  ManagementRequestMessage,
  ManagementSide,
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
import { dbNow } from '../db-clock';
import { RequestAccess, type Audience } from './request-access';
import { RequestProgress } from './request-progress';
import { assertCan } from './request-rules';

export const MESSAGE_RESOURCE = 'management_request_message';
export const MESSAGE_LENGTH = { min: 1, max: 4000 } as const;
/** Photos and documents on one message. */
export const MAX_ATTACHMENTS = 5;

export interface NewMessage {
  side: ManagementSide;
  body: string;
  /** A staff note: no resident route returns it. */
  internal?: boolean;
  /** Chosen by staff when sending: the request is answered. */
  official?: boolean;
}

export interface PostedMessage {
  body: string;
  internal?: boolean;
  official?: boolean;
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
  message: ManagementRequestMessage;
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
 * A request's conversation (ADR 0039): the author and the staff, with
 * photos and documents. An `internal` message is a staff note: it and its
 * attachments are never returned on a resident route — the resident reads
 * filter in SQL, and the resident view has no field to carry it.
 *
 * A message is written once and never changes: the table's trigger refuses
 * everything but the erasure that clears its body. Bodies are content:
 * never audited, never in a notification.
 */
@Injectable()
export class MessagesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: RequestAccess,
    private readonly progress: RequestProgress,
    private readonly files: FilesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    // No body: the stored replay of a post holds no free text.
    this.idempotency.renderer(MESSAGE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const m = await tx.managementRequestMessage.findUniqueOrThrow({
          where: { id },
        });
        return { id: m.id, createdAt: m.createdAt };
      }),
    );
  }

  /**
   * The conversation as `audience` may read it. For the author: no note,
   * and so none of a note's attachments (they are read by message).
   */
  list(
    requestId: string,
    audience: Audience,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<MessageRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, requestId, audience);
      const limit = clampLimit(q.limit);
      const rows = await tx.managementRequestMessage.findMany({
        where: {
          AND: [
            { requestId },
            audience === 'resident' ? { internal: false } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        include: {
          sender: { select: { id: true, fullName: true, status: true } },
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const attachments = await this.attachmentsOf(
        tx,
        requestId,
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
    });
  }

  /**
   * The attachments of exactly these messages, each with a read URL. The
   * caller chose the messages: a reader who may not see a message never
   * names it here.
   */
  private async attachmentsOf(
    tx: TenantTxClient,
    requestId: string,
    messageIds: string[],
  ): Promise<Map<string, AttachmentRead[]>> {
    const out = new Map<string, AttachmentRead[]>();
    if (!messageIds.length) return out;
    const rows = await tx.managementRequestAttachment.findMany({
      where: { requestId, messageId: { in: messageIds } },
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
   * Posts to the conversation. The author writes on a request that is not
   * closed; staff reply on one that is not closed, and note on any. A
   * reply marked official answers the request; the author's message on an
   * answered request puts it back in hand; a note moves nothing at all, not
   * even the activity time the lists are ordered by.
   */
  post(
    requestId: string,
    audience: Audience,
    input: PostedMessage,
  ): Promise<ManagementRequestMessage> {
    const body = this.body(input.body);
    const side: ManagementSide = audience === 'resident' ? 'resident' : 'staff';
    const internal = side === 'staff' && input.internal === true;
    const official = side === 'staff' && input.official === true;
    if (internal && official)
      throw invalid('official', FieldErrorCode.INVALID_VALUE);
    const fileIds = this.fileIds(input.attachmentFileIds);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: MESSAGE_RESOURCE, id });
      await this.access.lockSelf(tx);
      const request = await this.access.load(tx, requestId, audience, {
        lock: true,
      });
      assertCan(
        request,
        side === 'resident' ? 'message' : internal ? 'note' : 'reply',
      );
      const now = await dbNow(tx);
      const message = await this.write(
        tx,
        request,
        { side, body, internal, official },
        now,
        id,
      );
      await this.attach(tx, message, fileIds, 'attachmentFileIds');
      if (!internal)
        await this.progress.afterMessage(tx, request, { side, official }, now);
      return message;
    });
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
   * Inside the caller's transaction, under the request's lock: the row, by
   * the caller, in the request's current cycle and at `at` (the database's
   * clock, read after the lock).
   */
  write(
    tx: TenantTxClient,
    request: Pick<ManagementRequest, 'id' | 'tenantId' | 'cycle'>,
    message: NewMessage,
    at: Date,
    id = newId(),
  ): Promise<ManagementRequestMessage> {
    return tx.managementRequestMessage.create({
      data: {
        id,
        tenantId: request.tenantId,
        requestId: request.id,
        senderId: this.ctx.accountId,
        senderSide: message.side,
        internal: message.side === 'staff' && message.internal === true,
        official: message.side === 'staff' && message.official === true,
        body: message.body,
        cycle: request.cycle,
        createdAt: at,
      },
    });
  }

  /**
   * Moves the caller's own finalized `request_attachment` files to the
   * message: they no longer have an owner, so the uploader's erasure leaves
   * them (as a ticket's photos, ADR 0029). Anything else is
   * FILE_NOT_AVAILABLE on `<field>.<index>`.
   */
  async attach(
    tx: TenantTxClient,
    message: Pick<
      ManagementRequestMessage,
      'id' | 'tenantId' | 'requestId' | 'createdAt'
    >,
    fileIds: readonly string[],
    field: string,
  ): Promise<void> {
    for (const [i, fileId] of fileIds.entries()) {
      const file = await this.files.claim(tx, fileId, 'request_attachment');
      if (!file)
        throw invalid(`${field}.${i}`, FieldErrorCode.FILE_NOT_AVAILABLE);
      await this.files.attach(tx, file);
      await tx.managementRequestAttachment.create({
        data: {
          id: newId(),
          tenantId: message.tenantId,
          requestId: message.requestId,
          messageId: message.id,
          fileId: file.id,
          uploadedById: this.ctx.accountId,
          createdAt: message.createdAt,
        },
      });
    }
  }
}
