import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { ClaimsService } from '../claims/claims.service';
import { ComplaintMessagesService } from '../complaints/complaint-messages.service';
import { complaintNumber } from '../complaints/complaint-rules';
import { ComplaintsService } from '../complaints/complaints.service';
import { NoticesService } from '../complaints/notices.service';
import { ResidentComplaintDetailView } from '../complaints/views/complaint.views';
import { ResidentComplaintMessageView } from '../complaints/views/message.views';
import { UnitNoticeView } from '../complaints/views/notice.views';
import { BlocksService } from '../conversations/blocks.service';
import { ConversationsService } from '../conversations/conversations.service';
import {
  BlockView,
  ConversationMessageView,
  ConversationView,
} from '../conversations/views/conversation.views';
import { PostsService } from '../posts/posts.service';
import { BoardPostView, MyClaimView } from '../posts/views/post.views';

/** Rows read per page while exporting. */
const PAGE = 100;

/**
 * The neighbours section of a personal-data export (ADR 0036, 0042). It
 * runs as the account and reads through the account's own services and
 * views, so nothing the account cannot read can be in it:
 *
 * - `neighbours/complaints/NC-000123.json`: each complaint the account
 *   filed, as its own detail shows it, with its own thread with the
 *   management. Never a staff note, never the other unit's thread;
 * - `neighbours/notices/<id>.json`: each notice it still answers for, as
 *   the unit reads it, with the management's messages and its own;
 * - `neighbours/posts.json`: its posts on the boards;
 * - `neighbours/claims.json`: its claims on found items;
 * - `neighbours/conversations/<id>.json`: its side of each masked
 *   conversation: its own messages, and the other side's only as a count;
 * - `neighbours/blocks.json`: its blocks, each a building and a date.
 *
 * Nothing here is another person's identity. A sender is `mine` or not,
 * never a name; the other side of a conversation is the building the
 * account already sees, and no first name even once names were shown; what
 * a co-recipient of a notice or the other side of a conversation wrote is
 * theirs and is left out. Files are records of the complaint or the post:
 * a count, never a URL.
 */
@Injectable()
export class NeighboursExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly complaints: ComplaintsService,
    private readonly complaintMessages: ComplaintMessagesService,
    private readonly notices: NoticesService,
    private readonly posts: PostsService,
    private readonly claims: ClaimsService,
    private readonly conversations: ConversationsService,
    private readonly blocks: BlocksService,
  ) {}

  onModuleInit(): void {
    this.sections.register('neighbours', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    yield* this.filed(s);
    yield* this.received(s);

    const posts: object[] = [];
    for await (const post of this.pages((cursor) =>
      this.posts.board({ mine: 'true', cursor, limit: PAGE }),
    )) {
      // Its own post: no author label, and the photos as a count.
      const view: Partial<BoardPostView> = BoardPostView.from(post);
      const photoCount = view.photos?.length ?? 0;
      delete view.photos;
      delete view.author;
      posts.push({ ...view, photoCount });
    }
    yield { path: 'neighbours/posts.json', json: posts };

    yield {
      path: 'neighbours/claims.json',
      json: (await this.claims.listMine()).map((c) => MyClaimView.from(c)),
    };

    for await (const read of this.pages((cursor) =>
      this.conversations.listMine({ cursor, limit: PAGE }),
    )) {
      const { other, ...view } = ConversationView.from(read);
      const mine: object[] = [];
      let theirs = 0;
      for await (const m of this.pages((cursor) =>
        this.conversations.thread(view.id, { cursor, limit: PAGE }),
      )) {
        const message = ConversationMessageView.from(m);
        if (message.mine) mine.push(message);
        else theirs += 1;
      }
      yield {
        path: `neighbours/conversations/${view.id}.json`,
        json: {
          ...view,
          other: { building: other.building },
          messages: mine,
          otherSideMessageCount: theirs,
        },
      };
    }

    yield {
      path: 'neighbours/blocks.json',
      json: (await this.blocks.listMine()).map((b) => BlockView.from(b)),
    };
  }

  /** The complaints the account filed, each with its own thread. */
  private async *filed(s: ExportSubject): AsyncIterable<ExportEntry> {
    const ids = await this.tenantTx.withTenantTx((tx) =>
      tx.neighbourComplaint.findMany({
        where: { authorId: s.accountId },
        orderBy: { number: 'asc' },
        select: { id: true, number: true },
      }),
    );
    for (const c of ids) {
      const view = ResidentComplaintDetailView.fromDetail(
        await this.complaints.detail(c.id),
      );
      const messages: object[] = [];
      for await (const m of this.pages((cursor) =>
        this.complaintMessages.list(c.id, 'author', 'complainant', {
          cursor,
          limit: PAGE,
        }),
      ))
        messages.push(this.message(m, s.accountId));
      yield {
        path: `neighbours/complaints/${complaintNumber(c.number)}.json`,
        json: { ...view, messages },
      };
    }
  }

  /** The notices the account still answers for: the management's words and its own. */
  private async *received(s: ExportSubject): AsyncIterable<ExportEntry> {
    for (const read of await this.notices.listMine()) {
      const view = UnitNoticeView.from(read);
      const messages: object[] = [];
      for await (const m of this.pages((cursor) =>
        this.notices.thread(view.id, { cursor, limit: PAGE }),
      ))
        // A co-recipient's answer is theirs, not the account's.
        if (m.message.senderSide === 'staff' || m.sender.id === s.accountId)
          messages.push(this.message(m, s.accountId));
      yield {
        path: `neighbours/notices/${view.id}.json`,
        json: { ...view, messages },
      };
    }
  }

  /** A thread message with no sender: `mine` or the management's. */
  private message(
    m: Parameters<typeof ResidentComplaintMessageView.from>[0],
    accountId: string,
  ): object {
    const view: Partial<ResidentComplaintMessageView> =
      ResidentComplaintMessageView.from(m);
    const attachmentCount = view.attachments?.length ?? 0;
    delete view.attachments;
    delete view.sender;
    return { ...view, mine: m.sender.id === accountId, attachmentCount };
  }

  /** Every item of a cursor-paged read, page by page. */
  private async *pages<T>(
    read: (
      cursor: string | undefined,
    ) => Promise<{ items: T[]; nextCursor: string | null }>,
  ): AsyncIterable<T> {
    let cursor: string | undefined;
    do {
      const page = await read(cursor);
      yield* page.items;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}
