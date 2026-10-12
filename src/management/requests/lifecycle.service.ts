import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ManagementActorSide, ManagementRequest } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { MessagesService, type PostedMessage } from './messages.service';
import { RequestAccess } from './request-access';
import { RequestProgress } from './request-progress';
import {
  assertCan,
  mayReopen,
  REOPEN_DAYS,
  responseDueAt,
} from './request-rules';

export const AUTO_CLOSE_SWEEP = 'management.auto_close';

const DAY = 86_400_000;
const SWEEP_BATCH = 500;

type CloseReason =
  | (typeof REASON_CODES.managementRequestClose)[number]
  | (typeof REASON_CODES.managementRequestSystemClose)[number];

/** Runs in the closing transaction, under the request's lock. */
type ClosingHandler = (
  tx: TenantTxClient,
  request: ManagementRequest,
  now: Date,
) => Promise<void>;

/**
 * The ends and new beginnings of a request (ADR 0039): staff take it in
 * hand or close it, the author withdraws or reopens it, and the sweep
 * closes an answered one nobody replied to. Every one locks the request,
 * reads it again and asks request-rules, so of two that race one wins and
 * the other is told the status it found.
 */
@Injectable()
export class RequestLifecycle implements OnModuleInit {
  private readonly closing: ClosingHandler[] = [];

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly access: RequestAccess,
    private readonly progress: RequestProgress,
    private readonly messages: MessagesService,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(AUTO_CLOSE_SWEEP, (now) => this.autoClose(now));
  }

  /**
   * What must end with a request (its live appointment): each handler runs
   * in the closing transaction, whoever closes — staff, the author or the
   * sweep — and a handler that throws keeps the request open.
   */
  onClosing(handler: ClosingHandler): void {
    this.closing.push(handler);
  }

  /** Staff take an open request in hand without writing: a response. */
  start(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.access.load(tx, id, 'staff', { lock: true });
      assertCan(request, 'start');
      await this.progress.responded(tx, request, 'start', await dbNow(tx));
    });
  }

  /** Staff close it, with a reason code from the closed list. */
  close(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.managementRequestClose,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.access.load(tx, id, 'staff', { lock: true });
      assertCan(request, 'close');
      await this.closeRow(tx, request, reason, 'staff', await dbNow(tx));
    });
  }

  /**
   * The author no longer needs it: closed, with no reason to pick. It can
   * be reopened like any closed request.
   */
  withdraw(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.access.load(tx, id, 'resident', {
        lock: true,
      });
      assertCan(request, 'withdraw');
      await this.closeRow(
        tx,
        request,
        'withdrawn_by_author',
        'resident',
        await dbNow(tx),
      );
    });
  }

  /**
   * The author reopens a closed request within REOPEN_DAYS of the close,
   * saying why (a message): a new cycle starts now. It is open again, the
   * response clock runs afresh from the topic's target as it is today, and
   * the cycle may be escalated once more. Whoever handled it keeps it.
   */
  reopen(id: string, input: PostedMessage): Promise<void> {
    const body = this.messages.body(input.body);
    const fileIds = this.messages.fileIds(input.attachmentFileIds);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.access.load(tx, id, 'resident', {
        lock: true,
      });
      assertCan(request, 'reopen');
      const now = await dbNow(tx);
      if (!mayReopen(request.closedAt!, now))
        throw appError.conflict(
          ErrorCode.MANAGEMENT_REQUEST_REOPEN_WINDOW_PASSED,
          'Too late to reopen; open a new request',
          { params: { reopenDays: REOPEN_DAYS } },
        );
      const topic = await tx.managementRequestTopic.findUniqueOrThrow({
        where: { id: request.topicId },
        select: { targetResponseHours: true },
      });
      const reopened = await tx.managementRequest.update({
        where: { id },
        data: {
          status: 'open',
          cycle: request.cycle + 1,
          cycleStartedAt: now,
          responseDueAt: responseDueAt(now, topic.targetResponseHours),
          firstResponseAt: null,
          escalatedAt: null,
          answeredAt: null,
          closedAt: null,
          closeReason: null,
          closedBySide: null,
          lastActivityAt: now,
        },
      });
      const message = await this.messages.write(
        tx,
        reopened,
        { side: 'resident', body },
        now,
      );
      await this.messages.attach(tx, message, fileIds, 'attachmentFileIds');
      await this.audit.record(tx, {
        action: 'management_request.reopened',
        targetId: id,
        metadata: {
          requestNumber: request.number,
          cycle: reopened.cycle,
          closeReason: request.closeReason,
        },
      });
    });
  }

  /**
   * Closes answered requests whose author did not reply within the
   * compound's `autoCloseDays` of the official reply. One transaction per
   * request: the row is taken with SKIP LOCKED and checked again under its
   * lock, so the author's reply (which puts it back in hand) or a staff
   * close holding the row wins, and the sweep leaves it. Run twice, or on
   * two instances at once, it closes each request once.
   */
  autoClose(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const settings = await tx.managementRequestSettings.findUnique({
          where: { tenantId },
        });
        if (!settings) return [];
        const cutoff = new Date(now.getTime() - settings.autoCloseDays * DAY);
        const due = await tx.managementRequest.findMany({
          where: { status: 'answered', answeredAt: { lte: cutoff } },
          orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }],
          take: SWEEP_BATCH,
          select: { id: true },
        });
        return due.map((r) => ({ id: r.id, cutoff }));
      },
      async (tx, _tenantId, { id, cutoff }) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM management_requests
           WHERE id = ${id}::uuid AND status = 'answered'
             AND answered_at <= ${cutoff}
             FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const request = await tx.managementRequest.findUniqueOrThrow({
          where: { id },
        });
        await this.closeRow(tx, request, 'auto_closed', 'system', now);
        return 1;
      },
    );
  }

  /** The close itself, under the request's lock, whoever closes. */
  private async closeRow(
    tx: TenantTxClient,
    request: ManagementRequest,
    reason: CloseReason,
    side: ManagementActorSide,
    now: Date,
  ): Promise<void> {
    await tx.managementRequest.update({
      where: { id: request.id },
      data: {
        status: 'closed',
        closedAt: now,
        closeReason: reason,
        closedBySide: side,
        lastActivityAt: now,
      },
    });
    for (const handler of this.closing) await handler(tx, request, now);
    await this.audit.record(tx, {
      action:
        side === 'system'
          ? 'management_request.auto_closed'
          : side === 'resident'
            ? 'management_request.withdrawn'
            : 'management_request.closed',
      targetId: request.id,
      metadata: {
        requestNumber: request.number,
        cycle: request.cycle,
        fromStatus: request.status,
        ...(side === 'staff' ? { reasonCode: reason } : {}),
      },
    });
  }
}
