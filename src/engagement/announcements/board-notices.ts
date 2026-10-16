import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  AnnouncementsService,
  BODY_MAX,
  TITLE_MAX,
  type BoardNoticeText,
} from './announcements.service';

export {
  BODY_MAX as BOARD_NOTICE_BODY_MAX,
  TITLE_MAX as BOARD_NOTICE_TITLE_MAX,
};
export type { BoardNoticeText };

/**
 * The one thing engagement offers another domain (ADR 0051): the board's
 * decisions and minutes as announcements of kind `board` to the owners,
 * written in the caller's transaction. Governance keeps its own record of
 * each (board_publications); a deferred trigger holds that every `board`
 * announcement has exactly one.
 */
@Injectable()
export class BoardNotices {
  constructor(private readonly announcements: AnnouncementsService) {}

  /** Out now, to the owners, at normal priority; one PDF at most. Its id. */
  publish(
    tx: TenantTxClient,
    input: BoardNoticeText & { attachmentFileId?: string | null },
  ): Promise<string> {
    return this.announcements.publishBoard(tx, input);
  }

  edit(tx: TenantTxClient, id: string, input: BoardNoticeText): Promise<void> {
    return this.announcements.editBoard(tx, id, input);
  }

  archive(tx: TenantTxClient, id: string): Promise<void> {
    return this.announcements.archiveBoard(tx, id);
  }

  text(tx: TenantTxClient, id: string) {
    return this.announcements.boardText(tx, id);
  }
}
