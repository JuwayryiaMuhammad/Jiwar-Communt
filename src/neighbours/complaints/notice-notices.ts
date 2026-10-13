import { Injectable } from '@nestjs/common';
import { CommunityNeighboursPort } from '../../community';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';

/** A notice with what its notifications need: its unit and its category. */
export interface NoticeSubject {
  id: string;
  recipientKind: 'household' | 'owners';
  complaint: { targetUnitId: string; categoryId: string };
}

/**
 * What the unit complained about is told (ADR 0042): that a notice
 * arrived, and that the management wrote to it again. The target is the
 * notice and the only param is the category's key: never the complaint's
 * number (two neighbours comparing numbers would name the complainant),
 * never a word of anyone's.
 */
@Injectable()
export class NoticeNotices {
  constructor(
    private readonly notifier: Notifier,
    private readonly community: CommunityNeighboursPort,
  ) {}

  /**
   * Tells whoever the notice went to and still answers for the unit in
   * that capacity: a household that has moved out is told nothing more.
   */
  async toRecipients(
    tx: TenantTxClient,
    notice: NoticeSubject,
    kind: NotificationKind,
    now: Date,
  ): Promise<void> {
    const rows = await tx.neighbourComplaintNoticeRecipient.findMany({
      where: { noticeId: notice.id, account: { status: 'active' } },
      select: { accountId: true },
      orderBy: { accountId: 'asc' },
    });
    const to: string[] = [];
    for (const r of rows)
      if (
        await this.community.stillRecipient(
          tx,
          notice.complaint.targetUnitId,
          r.accountId,
          notice.recipientKind,
          now,
        )
      )
        to.push(r.accountId);
    if (!to.length) return;
    const category = await tx.neighbourComplaintCategory.findUniqueOrThrow({
      where: { id: notice.complaint.categoryId },
      select: { key: true },
    });
    await this.notifier.notify(tx, to, {
      kind,
      params: { categoryKey: category.key },
      targetId: notice.id,
    });
  }
}
