import { Injectable } from '@nestjs/common';
import type { RequestReplyTemplate } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { MESSAGE_LENGTH } from '../requests/messages.service';
import { RequestAccess } from '../requests/request-access';

/** The CHECK request_reply_templates_text. */
export const REPLY_TEMPLATE_NAME = { min: 1, max: 80 } as const;
export const REPLY_TEMPLATE_BODY = MESSAGE_LENGTH;
/** A compound keeps at most this many; the list is read whole. */
export const MAX_REPLY_TEMPLATES = 300;

export interface ReplyTemplateInput {
  name?: string;
  /** Null: for any topic. */
  topicId?: string | null;
  bodyEn?: string | null;
  bodyAr?: string | null;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const replyTemplateNotFound = () =>
  appError.notFound(
    ErrorCode.REPLY_TEMPLATE_NOT_FOUND,
    'Reply template not found',
  );

/**
 * What staff pick from when they answer in the queue (ADR 0080): a name, a
 * topic or none (any topic), and the words in English, Arabic or both. The
 * composer copies one in and edits it; nothing points back at it, so it is
 * changed and deleted freely. Read by whoever handles requests
 * (`requests.handle`), written by `requests.manage`. Audited by name and
 * topic; the words as "changed".
 */
@Injectable()
export class ReplyTemplatesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: RequestAccess,
    private readonly audit: AuditService,
  ) {}

  /** For one topic: its own and the ones for any topic, by name. */
  list(topicId?: string): Promise<RequestReplyTemplate[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.requestReplyTemplate.findMany({
        where: topicId ? { OR: [{ topicId }, { topicId: null }] } : {},
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: MAX_REPLY_TEMPLATES,
      }),
    );
  }

  create(
    input: ReplyTemplateInput & { name: string },
  ): Promise<RequestReplyTemplate> {
    const words = this.words(input, null);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const topicId = await this.topic(tx, input.topicId ?? null);
      const name = input.name.trim();
      const template = await tx.requestReplyTemplate.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          topicId,
          name,
          ...words,
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'reply_template.created',
        targetId: template.id,
        metadata: { name, topicId },
      });
      return template;
    });
  }

  update(id: string, input: ReplyTemplateInput): Promise<RequestReplyTemplate> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const words = this.words(input, before);
      const topicId =
        input.topicId === undefined
          ? before.topicId
          : await this.topic(tx, input.topicId);
      const name = input.name?.trim() ?? before.name;
      const after = await tx.requestReplyTemplate.update({
        where: { id },
        data: { name, topicId, ...words },
      });
      const wordsChanged =
        after.bodyEn !== before.bodyEn || after.bodyAr !== before.bodyAr;
      const changes = {
        ...(name !== before.name
          ? { name: { from: before.name, to: name } }
          : {}),
        ...(topicId !== before.topicId
          ? { topicId: { from: before.topicId, to: topicId } }
          : {}),
        ...(wordsChanged ? { words: { changed: true as const } } : {}),
      };
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'reply_template.changed',
          targetId: id,
          changes,
        });
      return after;
    });
  }

  delete(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      await tx.requestReplyTemplate.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'reply_template.deleted',
        targetId: id,
        metadata: { name: before.name, topicId: before.topicId },
      });
    });
  }

  /** English, Arabic or both: at least one (FIELD_REQUIRED on `bodyEn`). */
  private words(
    input: ReplyTemplateInput,
    base: RequestReplyTemplate | null,
  ): { bodyEn: string | null; bodyAr: string | null } {
    const pick = (given: string | null | undefined, was: string | null) =>
      given === undefined ? was : given?.trim() || null;
    const out = {
      bodyEn: pick(input.bodyEn, base?.bodyEn ?? null),
      bodyAr: pick(input.bodyAr, base?.bodyAr ?? null),
    };
    if (out.bodyEn === null && out.bodyAr === null)
      throw invalid([{ field: 'bodyEn', code: FieldErrorCode.FIELD_REQUIRED }]);
    return out;
  }

  /** A topic of the compound, active or not (INVALID_VALUE on `topicId`). */
  private async topic(
    tx: TenantTxClient,
    topicId: string | null,
  ): Promise<string | null> {
    if (topicId === null) return null;
    const topic = await tx.managementRequestTopic.findUnique({
      where: { id: topicId },
      select: { id: true },
    });
    if (!topic)
      throw invalid([{ field: 'topicId', code: FieldErrorCode.INVALID_VALUE }]);
    return topic.id;
  }

  private async locked(
    tx: TenantTxClient,
    id: string,
  ): Promise<RequestReplyTemplate> {
    await tx.$queryRaw`SELECT id FROM request_reply_templates WHERE id = ${id}::uuid FOR UPDATE`;
    const t = await tx.requestReplyTemplate.findUnique({ where: { id } });
    if (!t) throw replyTemplateNotFound();
    return t;
  }
}
