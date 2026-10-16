import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BoardPublication } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { addDays, localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { BoardNotices, type BoardNoticeText } from '../../engagement';
import { GovernanceAccess } from '../access';
import { BoardService } from '../board/board.service';
import { dbNow } from '../db-clock';

export const BOARD_PUBLICATION_RESOURCE = 'board_publication';
const PAGE = keysetCursor('createdAt', 'desc');
/** How long ago a published decision may have been taken. */
export const DECIDED_WITHIN_DAYS = 366;

export type PublicationKind = 'decision' | 'minutes';

export interface NewPublication extends BoardNoticeText {
  kind: PublicationKind;
  decidedOn: string;
  attachmentFileId?: string | null;
}

export interface PublicationRecord {
  publication: BoardPublication;
  text: BoardNoticeText & { attachments: number; editedAt: Date | null };
}

export const publicationNotFound = () =>
  appError.notFound(
    ErrorCode.BOARD_PUBLICATION_NOT_FOUND,
    'Board publication not found',
  );

/**
 * The board's decisions and minutes (ADR 0051): the board (or the manager
 * for it) publishes them to the owners as announcements of kind `board`,
 * with an optional PDF (engagement's BoardNotices, in this transaction),
 * while a board sits. Governance keeps the record: which kind, which board,
 * decided on which day. The words change by a new version of the
 * announcement; archiving takes it down for good.
 */
@Injectable()
export class BoardPublicationsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly board: BoardService,
    private readonly notices: BoardNotices,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(BOARD_PUBLICATION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.load(
          tx,
          await tx.boardPublication.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  publish(input: NewPublication): Promise<PublicationRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const author = await this.access.requireAuthor(tx);
      const now = await dbNow(tx);
      const sitting = await this.board.sitting(tx, now);
      if (!sitting)
        throw appError.conflict(
          ErrorCode.BOARD_NOT_SITTING,
          'No board sits now',
        );
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = localDate(now, timezone);
      const earliest = addDays(today, -DECIDED_WITHIN_DAYS);
      if (input.decidedOn > today || input.decidedOn < earliest)
        throw invalid([
          {
            field: 'decidedOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { min: earliest, max: today },
          },
        ]);
      const id = newId();
      await this.idempotency.claim(tx, {
        type: BOARD_PUBLICATION_RESOURCE,
        id,
      });
      const announcementId = await this.notices.publish(tx, input);
      const publication = await tx.boardPublication.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          kind: input.kind,
          termId: sitting.term.id,
          announcementId,
          decidedOn: new Date(`${input.decidedOn}T00:00:00.000Z`),
          authorSide: author.side,
          publishedById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'board_publication.published',
        targetId: id,
        metadata: {
          kind: input.kind,
          termId: sitting.term.id,
          announcementId,
          decidedOn: input.decidedOn,
          attachment: Boolean(input.attachmentFileId),
          side: author.side,
        },
      });
      return this.load(tx, publication);
    });
  }

  /** New words: a new version of its announcement. */
  edit(id: string, input: BoardNoticeText): Promise<PublicationRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.requireAuthor(tx);
      const publication = await this.live(tx, id);
      await this.notices.edit(tx, publication.announcementId, input);
      return this.load(tx, publication);
    });
  }

  archive(id: string): Promise<PublicationRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const author = await this.access.requireAuthor(tx);
      const publication = await this.live(tx, id);
      await this.notices.archive(tx, publication.announcementId);
      const now = await dbNow(tx);
      const archived = await tx.boardPublication.update({
        where: { id },
        data: { archivedAt: now },
      });
      await this.audit.record(tx, {
        action: 'board_publication.archived',
        targetId: id,
        metadata: {
          kind: publication.kind,
          announcementId: publication.announcementId,
          side: author.side,
        },
      });
      return this.load(tx, archived);
    });
  }

  /** The owners' list: what is not archived, newest first. */
  ownersList(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<PublicationRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.requireOwner(tx);
      return this.page(tx, q, false);
    });
  }

  staffList(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<PublicationRecord>> {
    return this.tenantTx.withTenantTx((tx) => this.page(tx, q, true));
  }

  private async page(
    tx: TenantTxClient,
    q: { cursor?: string; limit?: number },
    archived: boolean,
  ): Promise<Page<PublicationRecord>> {
    const limit = clampLimit(q.limit);
    const rows = await tx.boardPublication.findMany({
      where: {
        AND: [
          ...(archived ? [] : [{ archivedAt: null }]),
          ...PAGE.after(q.cursor),
        ],
      },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    const page = PAGE.toPage(rows, limit);
    const items: PublicationRecord[] = [];
    for (const p of page.items) items.push(await this.load(tx, p));
    return { items, nextCursor: page.nextCursor };
  }

  /** The publication locked, not archived. */
  private async live(
    tx: TenantTxClient,
    id: string,
  ): Promise<BoardPublication> {
    await tx.$queryRaw`SELECT id FROM board_publications WHERE id = ${id}::uuid FOR UPDATE`;
    const p = await tx.boardPublication.findUnique({ where: { id } });
    if (!p || p.archivedAt) throw publicationNotFound();
    return p;
  }

  private async load(
    tx: TenantTxClient,
    publication: BoardPublication,
  ): Promise<PublicationRecord> {
    return {
      publication,
      text: await this.notices.text(tx, publication.announcementId),
    };
  }
}
