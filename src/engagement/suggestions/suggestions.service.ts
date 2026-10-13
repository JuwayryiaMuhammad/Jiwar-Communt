import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  Prisma,
  Suggestion,
  SuggestionStatus,
  SuggestionTopic,
  SuggestionUpdate,
} from '@prisma/client';
import { CommunityEngagementPort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { EngagementAccess } from '../access';
import {
  CommunityAttachments,
  type AttachmentRead,
} from '../content/attachments';
import { invalid, localized } from '../../core/common/localized';
import { dbNow } from '../db-clock';
import {
  canMove,
  DONE_NOTE_MAX,
  needsResponse,
  PUBLIC_TEXT_MAX,
  PUBLIC_TITLE_MAX,
  SUGGESTION_BODY,
} from './suggestion-rules';

export const SUGGESTION_RESOURCE = 'suggestion';

const SUMMARY = [
  { name: 'title', max: PUBLIC_TITLE_MAX },
  { name: 'text', max: PUBLIC_TEXT_MAX },
] as const;
const NOTE = [{ name: 'note', max: DONE_NOTE_MAX }] as const;

export interface NewSuggestion {
  topicId: string;
  body: string;
  unitId?: string;
}

export interface SummaryInput {
  titleEn?: string | null;
  textEn?: string | null;
  titleAr?: string | null;
  textAr?: string | null;
}

export interface DoneNoteInput {
  noteEn?: string | null;
  noteAr?: string | null;
  attachmentFileIds?: string[];
}

/** A suggestion as it is read, with what each side may see added by the view. */
export interface SuggestionRead {
  suggestion: Suggestion;
  topic: SuggestionTopic;
  supports: number;
  /** The reader supports it; null for the staff. */
  supported: boolean | null;
  /** Null in a list. */
  updates: SuggestionUpdate[] | null;
  /** The "we did" photos; null in a list that does not show them. */
  photos: AttachmentRead[] | null;
  /** The staff's view only. */
  author: { id: string; fullName: string | null } | null;
  unitCode: string | null;
}

const byCreation = keysetCursor('createdAt');
const byPublication = keysetCursor('publishedAt');
const byDone = keysetCursor('doneAt');

export const suggestionNotFound = () =>
  appError.notFound(ErrorCode.SUGGESTION_NOT_FOUND, 'Suggestion not found');

const wrongState = (s: Pick<Suggestion, 'status' | 'publishedAt'>) =>
  appError.conflict(
    ErrorCode.SUGGESTION_INVALID_STATE,
    'The suggestion does not take this action now',
    { params: { status: s.status, published: s.publishedAt !== null } },
  );

/**
 * Suggestions (ADR 0040).
 *
 * A resident writes one under a topic; it is private to them and to the
 * staff who handle suggestions (`community.suggestions`), who move it
 * forward and answer it. The author is told of each move and each answer.
 *
 * The staff may put a suggestion on the public board. What the board
 * shows is a summary the staff write, never the resident's words and never
 * who they are; residents support it, once each, and may take that back.
 * A suggestion that was done, with the staff's note and photos, is in the
 * "you said, we did" list.
 *
 * An erasure clears the author's words and deletes the supports they gave;
 * what the staff wrote stays, the public summary included.
 */
@Injectable()
export class SuggestionsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: EngagementAccess,
    private readonly community: CommunityEngagementPort,
    private readonly attachments: CommunityAttachments,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(SUGGESTION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const s = await tx.suggestion.findUniqueOrThrow({ where: { id } });
        return { id: s.id, createdAt: s.createdAt };
      }),
    );
    // Erasure (ADR 0023, 0040): the account's own words go, and the
    // supports it gave. The suggestions stay, pointing at the tombstone,
    // with everything the staff wrote. Any write of the account's took a
    // share lock on its row first, so none is in flight here.
    this.lifecycle.onErasing(async (tx, account) => {
      await tx.$executeRaw`
        UPDATE suggestions
           SET body = NULL, erased_at = date_trunc('milliseconds', now())
         WHERE author_account_id = ${account.id}::uuid AND body IS NOT NULL`;
      await tx.suggestionSupport.deleteMany({
        where: { accountId: account.id },
      });
      return [];
    });
  }

  // --------------------------------------------------------------------------
  // The author
  // --------------------------------------------------------------------------

  create(input: NewSuggestion): Promise<Suggestion> {
    const me = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const body = input.body.trim();
    if (body.length < SUGGESTION_BODY.min || body.length > SUGGESTION_BODY.max)
      throw invalid([
        {
          field: 'body',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...SUGGESTION_BODY },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: SUGGESTION_RESOURCE, id });
      await this.access.lockSelf(tx);
      if (input.unitId) {
        const places = await this.community.places(tx, me);
        if (!places.some((p) => p.unitId === input.unitId))
          throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      }
      const topic = await tx.suggestionTopic.findFirst({
        where: { id: input.topicId, active: true },
      });
      if (!topic)
        throw invalid([
          { field: 'topicId', code: FieldErrorCode.TOPIC_NOT_AVAILABLE },
        ]);
      const suggestion = await tx.suggestion.create({
        data: {
          id,
          tenantId,
          authorId: me,
          unitId: input.unitId,
          topicId: topic.id,
          body,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'suggestion.created',
        targetId: id,
        metadata: { topicKey: topic.key, withUnit: input.unitId !== undefined },
      });
      return suggestion;
    });
  }

  /** The caller's own suggestions, the newest first. */
  listMine(q: {
    cursor?: string;
    limit: number;
  }): Promise<Page<SuggestionRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.suggestion.findMany({
        where: { AND: [{ authorId: me }, ...byCreation.after(q.cursor)] },
        orderBy: byCreation.orderBy,
        take: q.limit + 1,
      });
      const page = byCreation.toPage(rows, q.limit);
      return { ...page, items: await this.reads(tx, page.items, me) };
    });
  }

  /** One of the caller's own: nobody else's is found by its id. */
  mine(id: string): Promise<SuggestionRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const s = await tx.suggestion.findUnique({ where: { id } });
      if (!s || s.authorId !== me) throw suggestionNotFound();
      return this.detail(tx, s, me);
    });
  }

  // --------------------------------------------------------------------------
  // The board and "you said, we did" (every resident)
  // --------------------------------------------------------------------------

  /** What the staff put on the board, the latest first. */
  board(q: {
    topicId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<SuggestionRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = (await tx.suggestion.findMany({
        where: {
          AND: [
            { publishedAt: { not: null } },
            q.topicId ? { topicId: q.topicId } : {},
            ...byPublication.after(q.cursor),
          ],
        },
        orderBy: byPublication.orderBy,
        take: q.limit + 1,
      })) as (Suggestion & { publishedAt: Date })[];
      const page = byPublication.toPage(rows, q.limit);
      return { ...page, items: await this.reads(tx, page.items, me) };
    });
  }

  /** Suggestions that were done and say what was done, the latest first. */
  done(q: { cursor?: string; limit: number }): Promise<Page<SuggestionRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = (await tx.suggestion.findMany({
        where: {
          AND: [
            { status: 'done' },
            {
              OR: [
                { doneNoteEn: { not: null } },
                { doneNoteAr: { not: null } },
              ],
            },
            ...byDone.after(q.cursor),
          ],
        },
        orderBy: byDone.orderBy,
        take: q.limit + 1,
      })) as (Suggestion & { doneAt: Date })[];
      const page = byDone.toPage(rows, q.limit);
      const reads = await this.reads(tx, page.items, me);
      for (const read of reads)
        read.photos = await this.photosOf(tx, read.suggestion);
      return { ...page, items: reads };
    });
  }

  /** The caller supports a published suggestion. Doing it twice changes nothing. */
  support(id: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const s = await this.published(tx, id);
      const { count } = await tx.suggestionSupport.createMany({
        data: [{ tenantId: s.tenantId, suggestionId: id, accountId: me }],
        skipDuplicates: true,
      });
      if (count)
        await this.audit.record(tx, {
          action: 'suggestion.supported',
          targetId: id,
        });
    });
  }

  /** The caller takes their support back. */
  unsupport(id: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.published(tx, id);
      const { count } = await tx.suggestionSupport.deleteMany({
        where: { suggestionId: id, accountId: me },
      });
      if (count)
        await this.audit.record(tx, {
          action: 'suggestion.unsupported',
          targetId: id,
        });
    });
  }

  // --------------------------------------------------------------------------
  // The staff
  // --------------------------------------------------------------------------

  listForStaff(q: {
    status?: SuggestionStatus;
    topicId?: string;
    published?: boolean;
    cursor?: string;
    limit: number;
  }): Promise<Page<SuggestionRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const where: Prisma.SuggestionWhereInput = {
        AND: [
          q.status ? { status: q.status } : {},
          q.topicId ? { topicId: q.topicId } : {},
          q.published === undefined
            ? {}
            : { publishedAt: q.published ? { not: null } : null },
          ...byCreation.after(q.cursor),
        ],
      };
      const rows = await tx.suggestion.findMany({
        where,
        orderBy: byCreation.orderBy,
        take: q.limit + 1,
      });
      const page = byCreation.toPage(rows, q.limit);
      return {
        ...page,
        items: await this.withAuthors(
          tx,
          await this.reads(tx, page.items, null),
        ),
      };
    });
  }

  getForStaff(id: string): Promise<SuggestionRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const s = await tx.suggestion.findUnique({ where: { id } });
      if (!s) throw suggestionNotFound();
      const [read] = await this.withAuthors(tx, [
        await this.detail(tx, s, null),
      ]);
      return read;
    });
  }

  /** A step forward, with or without an answer; a decline is answered. */
  move(
    id: string,
    status: SuggestionStatus,
    response: string | undefined,
  ): Promise<void> {
    const answer = response?.trim() || undefined;
    if (needsResponse(status) && !answer)
      throw invalid([
        { field: 'response', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      if (!canMove(before.status, status)) throw wrongState(before);
      const now = await dbNow(tx);
      await tx.suggestion.update({
        where: { id },
        data: {
          status,
          ...(answer ? { response: answer, respondedAt: now } : {}),
          ...(status === 'done' ? { doneAt: now } : {}),
        },
      });
      await this.record(tx, before, status, answer, now);
      await this.audit.record(tx, {
        action: 'suggestion.status_changed',
        targetId: id,
        metadata: {
          from: before.status,
          to: status,
          withResponse: answer !== undefined,
        },
      });
      await this.tellAuthor(tx, before, status);
    });
  }

  /** The staff answer, or replace their answer, without moving it. */
  respond(id: string, response: string): Promise<void> {
    const answer = response.trim();
    if (!answer)
      throw invalid([
        { field: 'response', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const now = await dbNow(tx);
      await tx.suggestion.update({
        where: { id },
        data: { response: answer, respondedAt: now },
      });
      await this.record(tx, before, before.status, answer, now);
      await this.audit.record(tx, {
        action: 'suggestion.responded',
        targetId: id,
        metadata: { status: before.status },
      });
      await this.tellAuthor(tx, before, before.status);
    });
  }

  /**
   * Puts the suggestion on the board under a summary the staff write, or
   * rewrites the summary of one already there. The resident's words and
   * identity never go with it.
   */
  publish(id: string, input: SummaryInput): Promise<void> {
    const summary = localized(input, SUMMARY);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const now = await dbNow(tx);
      await tx.suggestion.update({
        where: { id },
        data: {
          publishedAt: before.publishedAt ?? now,
          publicTitleEn: summary.titleEn,
          publicTextEn: summary.textEn,
          publicTitleAr: summary.titleAr,
          publicTextAr: summary.textAr,
        },
      });
      await this.audit.record(tx, {
        action: 'suggestion.published',
        targetId: id,
        metadata: { rewritten: before.publishedAt !== null },
      });
    });
  }

  /** Takes it off the board, and its summary with it. Supports are kept. */
  unpublish(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      if (!before.publishedAt) throw wrongState(before);
      await tx.suggestion.update({
        where: { id },
        data: {
          publishedAt: null,
          publicTitleEn: null,
          publicTextEn: null,
          publicTitleAr: null,
          publicTextAr: null,
        },
      });
      await this.audit.record(tx, {
        action: 'suggestion.unpublished',
        targetId: id,
      });
    });
  }

  /** What was done, and its photos: a done suggestion's "we did". */
  doneNote(id: string, input: DoneNoteInput): Promise<void> {
    const note = localized(input, NOTE);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      if (before.status !== 'done') throw wrongState(before);
      const now = await dbNow(tx);
      let attachmentIds = before.doneAttachmentIds;
      if (input.attachmentFileIds !== undefined) {
        const wanted = this.attachments.ids(
          input.attachmentFileIds,
          'attachmentFileIds',
        );
        attachmentIds = [];
        for (const [i, fileId] of wanted.entries()) {
          if (before.doneAttachmentIds.includes(fileId)) {
            attachmentIds.push(fileId);
            continue;
          }
          const file = await this.attachments.take(
            tx,
            fileId,
            `attachmentFileIds.${i}`,
          );
          const row = await tx.suggestionAttachment.create({
            data: {
              id: newId(),
              tenantId: before.tenantId,
              suggestionId: id,
              fileId: file.id,
              uploadedById: this.ctx.accountId,
              createdAt: now,
            },
          });
          attachmentIds.push(row.id);
        }
      }
      await tx.suggestion.update({
        where: { id },
        data: {
          doneNoteEn: note.noteEn,
          doneNoteAr: note.noteAr,
          doneAttachmentIds: attachmentIds,
        },
      });
      await this.audit.record(tx, {
        action: 'suggestion.done_noted',
        targetId: id,
        metadata: { photos: attachmentIds.length },
      });
    });
  }

  /**
   * The account's own suggestions for a personal-data export, each with
   * the staff's answers to it. Inside the export's transaction.
   */
  async authoredBy(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<SuggestionRead[]> {
    const rows = await tx.suggestion.findMany({
      where: { authorId: accountId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const out: SuggestionRead[] = [];
    for (const s of rows) out.push(await this.detail(tx, s, accountId));
    return out;
  }

  /** The published suggestions the account supports, for the same export. */
  async supportedBy(tx: TenantTxClient, accountId: string): Promise<string[]> {
    const rows = await tx.suggestionSupport.findMany({
      where: { accountId, suggestion: { publishedAt: { not: null } } },
      select: { suggestionId: true },
      orderBy: { suggestionId: 'asc' },
    });
    return rows.map((r) => r.suggestionId);
  }

  // --------------------------------------------------------------------------
  // Pieces
  // --------------------------------------------------------------------------

  private async locked(tx: TenantTxClient, id: string): Promise<Suggestion> {
    await tx.$queryRaw`SELECT id FROM suggestions WHERE id = ${id}::uuid FOR UPDATE`;
    const s = await tx.suggestion.findUnique({ where: { id } });
    if (!s) throw suggestionNotFound();
    return s;
  }

  /** On the board, or SUGGESTION_NOT_FOUND: an unpublished one does not exist here. */
  private async published(tx: TenantTxClient, id: string): Promise<Suggestion> {
    const s = await tx.suggestion.findUnique({ where: { id } });
    if (!s || !s.publishedAt) throw suggestionNotFound();
    return s;
  }

  private async record(
    tx: TenantTxClient,
    s: Pick<Suggestion, 'id' | 'tenantId'>,
    status: SuggestionStatus,
    response: string | undefined,
    now: Date,
  ): Promise<void> {
    await tx.suggestionUpdate.create({
      data: {
        id: newId(),
        tenantId: s.tenantId,
        suggestionId: s.id,
        status,
        response,
        byId: this.ctx.accountId,
        createdAt: now,
      },
    });
  }

  /**
   * Tells the author their suggestion moved or was answered, if their
   * account is still active. Params: the status and the topic's key, never
   * a word of the suggestion or of the answer.
   */
  private async tellAuthor(
    tx: TenantTxClient,
    s: Pick<Suggestion, 'id' | 'authorId' | 'topicId'>,
    status: SuggestionStatus,
  ): Promise<void> {
    const author = await tx.account.findFirst({
      where: { id: s.authorId, status: 'active' },
      select: { id: true },
    });
    if (!author) return;
    const topic = await tx.suggestionTopic.findUniqueOrThrow({
      where: { id: s.topicId },
      select: { key: true },
    });
    await this.notifier.notify(tx, [author.id], {
      kind: 'community_suggestion.status_changed',
      params: { status, topicKey: topic.key },
      targetId: s.id,
    });
  }

  private async photosOf(
    tx: TenantTxClient,
    s: Pick<Suggestion, 'doneAttachmentIds'>,
  ): Promise<AttachmentRead[]> {
    if (!s.doneAttachmentIds.length) return [];
    const rows = await tx.suggestionAttachment.findMany({
      where: { id: { in: s.doneAttachmentIds } },
      include: { file: { select: { contentType: true } } },
    });
    const ordered = s.doneAttachmentIds.flatMap(
      (id) => rows.find((r) => r.id === id) ?? [],
    );
    return this.attachments.read(tx, ordered);
  }

  private async reads(
    tx: TenantTxClient,
    rows: readonly Suggestion[],
    reader: string | null,
  ): Promise<SuggestionRead[]> {
    if (!rows.length) return [];
    const ids = rows.map((s) => s.id);
    const topics = await tx.suggestionTopic.findMany({
      where: { id: { in: [...new Set(rows.map((s) => s.topicId))] } },
    });
    const supports = await tx.suggestionSupport.groupBy({
      by: ['suggestionId'],
      where: { suggestionId: { in: ids } },
      _count: { _all: true },
    });
    const mine = reader
      ? await tx.suggestionSupport.findMany({
          where: { suggestionId: { in: ids }, accountId: reader },
          select: { suggestionId: true },
        })
      : null;
    return rows.map((suggestion) => ({
      suggestion,
      topic: topics.find((t) => t.id === suggestion.topicId)!,
      supports:
        supports.find((s) => s.suggestionId === suggestion.id)?._count._all ??
        0,
      supported: mine
        ? mine.some((m) => m.suggestionId === suggestion.id)
        : null,
      updates: null,
      photos: null,
      author: null,
      unitCode: null,
    }));
  }

  private async detail(
    tx: TenantTxClient,
    s: Suggestion,
    reader: string | null,
  ): Promise<SuggestionRead> {
    const [read] = await this.reads(tx, [s], reader);
    return {
      ...read,
      updates: await tx.suggestionUpdate.findMany({
        where: { suggestionId: s.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      photos: await this.photosOf(tx, s),
    };
  }

  /** The staff's view names the author and the unit. */
  private async withAuthors(
    tx: TenantTxClient,
    reads: SuggestionRead[],
  ): Promise<SuggestionRead[]> {
    const names = await this.community.names(
      tx,
      reads.map((r) => r.suggestion.authorId),
    );
    const codes = await this.community.unitCodes(
      tx,
      reads.flatMap((r) => r.suggestion.unitId ?? []),
    );
    return reads.map((r) => ({
      ...r,
      author: {
        id: r.suggestion.authorId,
        fullName: names.get(r.suggestion.authorId) ?? null,
      },
      unitCode: r.suggestion.unitId
        ? (codes.get(r.suggestion.unitId) ?? null)
        : null,
    }));
  }
}
