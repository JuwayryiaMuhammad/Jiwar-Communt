import { Injectable } from '@nestjs/common';
import type {
  NeighbourComplaintCategory,
  NeighbourComplaintMessage,
  NeighbourComplaintNotice,
  NeighbourComplaintStatus,
} from '@prisma/client';
import { CommunityNeighboursPort, type NeighbourUnit } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import type { Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { ComplaintAccess } from './complaint-access';
import {
  COMPLAINT_MESSAGE_RESOURCE,
  ComplaintMessagesService,
  type MessageRead,
  type PostedMessage,
} from './complaint-messages.service';
import { ComplaintNotices } from './complaint-notices';
import { afterNotice, assertCan } from './complaint-rules';
import { ComplaintStatusService } from './complaint-status.service';
import { NoticeNotices } from './notice-notices';

export const NOTICE_LENGTH = { min: 1, max: 2000 } as const;
/** A unit's notices are few: one list, newest first. */
const LIST_CAP = 100;

/** A notice as the unit it was sent to reads it. */
export interface NoticeRead {
  notice: NeighbourComplaintNotice;
  category: NeighbourComplaintCategory;
  unit: NeighbourUnit;
  /** Whether the matter is still open: the unit may still answer. */
  status: NeighbourComplaintStatus;
}

type Loaded = NeighbourComplaintNotice & {
  complaint: {
    id: string;
    targetUnitId: string;
    categoryId: string;
    status: NeighbourComplaintStatus;
  };
};

export const noticeNotFound = () =>
  appError.notFound(ErrorCode.NEIGHBOUR_NOTICE_NOT_FOUND, 'Notice not found');

/**
 * The notice to the unit complained about, and the unit's side of it (ADR
 * 0042). The unit receives only this: the category and the management's
 * own text. Never the complaint's words, its evidence, its number, when it
 * was filed, or who filed it. It answers the management in its own thread,
 * which the complainant never reads.
 *
 * Who it went to is written down when it is sent — the household's primary
 * and whoever holds a live `household` delegation, or the owners of a unit
 * nobody lives in — and each of them reads it only while they still answer
 * for the unit in that capacity. Everyone else gets the one not-found.
 */
@Injectable()
export class NoticesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly access: ComplaintAccess,
    private readonly messages: ComplaintMessagesService,
    private readonly status: ComplaintStatusService,
    private readonly community: CommunityNeighboursPort,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly complaintNotices: ComplaintNotices,
    private readonly notices: NoticeNotices,
  ) {}

  /**
   * Staff send the one notice a complaint has. Locks: the caller's account,
   * the unit (so who answers for it cannot change while it is written
   * down), then the complaint. A complaint under review becomes
   * `notice_sent` and its author is told; one in mediation stays there.
   */
  send(complaintId: string, text: string): Promise<NeighbourComplaintNotice> {
    const body = text.trim();
    if (body.length < NOTICE_LENGTH.min || body.length > NOTICE_LENGTH.max)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid notice', {
        fields: [
          {
            field: 'body',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { ...NOTICE_LENGTH },
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      // The unit never changes (trigger): read it unlocked to lock it first.
      const { targetUnitId } = await this.access.load(tx, complaintId, 'staff');
      await this.community.lockUnit(tx, targetUnitId);
      const complaint = await this.access.load(tx, complaintId, 'staff', {
        lock: true,
      });
      assertCan(complaint, 'notice');
      if (await tx.neighbourComplaintNotice.count({ where: { complaintId } }))
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_NOTICE_ALREADY_SENT,
          'The unit was already sent its notice',
        );
      const now = await dbNow(tx);
      const to = await this.community.noticeRecipients(tx, targetUnitId, now);
      if (!to.accountIds.length)
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_NOTICE_NO_RECIPIENT,
          'Nobody answers for the unit',
        );
      const notice = await tx.neighbourComplaintNotice.create({
        data: {
          id: newId(),
          tenantId: complaint.tenantId,
          complaintId,
          body,
          recipientKind: to.kind,
          sentById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await tx.neighbourComplaintNoticeRecipient.createMany({
        data: to.accountIds.map((accountId) => ({
          tenantId: complaint.tenantId,
          noticeId: notice.id,
          accountId,
        })),
      });
      const facts = {
        noticeId: notice.id,
        recipientKind: to.kind,
        recipients: to.accountIds.length,
      };
      const next = afterNotice(complaint.status);
      if (next !== complaint.status)
        await this.status.move(
          tx,
          complaint,
          {
            to: next,
            side: 'staff',
            audit: 'neighbour_complaint.notice_sent',
            tellAuthor: 'neighbour_complaint.notice_sent',
          },
          now,
          facts,
        );
      else
        await this.audit.record(tx, {
          action: 'neighbour_complaint.notice_sent',
          targetId: complaint.id,
          metadata: {
            complaintNumber: complaint.number,
            from: complaint.status,
            to: complaint.status,
            ...facts,
          },
        });
      await this.notices.toRecipients(
        tx,
        { ...notice, complaint },
        'neighbour_notice.received',
        now,
      );
      return notice;
    });
  }

  // --------------------------------------------------------------------------
  // The unit's side
  // --------------------------------------------------------------------------

  /** The notices the caller still answers for, newest first. */
  listMine(): Promise<NoticeRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const rows = await tx.neighbourComplaintNotice.findMany({
        where: { recipients: { some: { accountId: this.ctx.accountId } } },
        include: { complaint: COMPLAINT },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_CAP,
      });
      const mine: Loaded[] = [];
      for (const n of rows) if (await this.answersFor(tx, n, now)) mine.push(n);
      return this.named(tx, mine);
    });
  }

  get(id: string): Promise<NoticeRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const notice = await this.load(tx, id, await dbNow(tx));
      return (await this.named(tx, [notice]))[0];
    });
  }

  /** The unit's own thread with the management: nothing of the complaint's. */
  thread(
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<MessageRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const notice = await this.load(tx, id, await dbNow(tx));
      return this.messages.read(tx, notice.complaintId, 'target', q);
    });
  }

  /**
   * The unit answers the management. The staff are told, on the complaint;
   * its author is told nothing and sees nothing move.
   */
  reply(id: string, input: PostedMessage): Promise<NeighbourComplaintMessage> {
    const body = this.messages.body(input.body);
    const fileIds = this.messages.fileIds(input.attachmentFileIds);
    return this.tenantTx.withTenantTx(async (tx) => {
      const messageId = newId();
      await this.idempotency.claim(tx, {
        type: COMPLAINT_MESSAGE_RESOURCE,
        id: messageId,
      });
      await this.self.lockSelf(tx);
      const found = await this.load(tx, id, await dbNow(tx));
      await this.access.lock(tx, found.complaintId);
      const now = await dbNow(tx);
      // Again under the lock: by the clock a waiting request decides on.
      const notice = await this.load(tx, id, now);
      const complaint = await tx.neighbourComplaint.findUniqueOrThrow({
        where: { id: notice.complaintId },
      });
      assertCan(complaint, 'target_message');
      const message = await this.messages.write(
        tx,
        complaint,
        { thread: 'target', side: 'resident', body },
        now,
        messageId,
      );
      await this.messages.attach(tx, message, fileIds, 'attachmentFileIds');
      await this.complaintNotices.toHandlers(
        tx,
        complaint,
        'neighbour_notice.unit_replied',
      );
      return message;
    });
  }

  /**
   * The notice, if it went to the caller and they still answer for the
   * unit as they did then; otherwise the one not-found, as for an unknown
   * id or another compound's.
   */
  private async load(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<Loaded> {
    const notice = await tx.neighbourComplaintNotice.findFirst({
      where: { id, recipients: { some: { accountId: this.ctx.accountId } } },
      include: { complaint: COMPLAINT },
    });
    if (!notice || !(await this.answersFor(tx, notice, now)))
      throw noticeNotFound();
    return notice;
  }

  private answersFor(tx: TenantTxClient, notice: Loaded, now: Date) {
    return this.community.stillRecipient(
      tx,
      notice.complaint.targetUnitId,
      this.ctx.accountId,
      notice.recipientKind,
      now,
    );
  }

  private async named(
    tx: TenantTxClient,
    notices: Loaded[],
  ): Promise<NoticeRead[]> {
    if (!notices.length) return [];
    const categories = new Map(
      (
        await tx.neighbourComplaintCategory.findMany({
          where: {
            id: {
              in: [...new Set(notices.map((n) => n.complaint.categoryId))],
            },
          },
        })
      ).map((c) => [c.id, c]),
    );
    const units = await this.community.units(
      tx,
      notices.map((n) => n.complaint.targetUnitId),
    );
    return notices.map(({ complaint, ...notice }) => ({
      notice,
      category: categories.get(complaint.categoryId)!,
      unit: units.get(complaint.targetUnitId)!,
      status: complaint.status,
    }));
  }
}

const COMPLAINT = {
  select: { id: true, targetUnitId: true, categoryId: true, status: true },
} as const;
