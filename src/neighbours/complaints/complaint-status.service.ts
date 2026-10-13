import { Injectable } from '@nestjs/common';
import type {
  NeighbourComplaint,
  NeighbourComplaintStatus,
  NeighbourSide,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantAuditAction } from '../../core/audit/actions';
import { RequestContext } from '../../core/common/cls/request-context';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { ComplaintAccess } from './complaint-access';
import { ComplaintNotices } from './complaint-notices';
import { assertCan, type ComplaintAction } from './complaint-rules';

interface Move {
  action: ComplaintAction;
  to: NeighbourComplaintStatus;
  side: NeighbourSide;
  reasonCode?: string;
  audit: TenantAuditAction;
  /** What the author is told; nothing when the author is the one moving it. */
  tellAuthor?: NotificationKind;
  /** What the staff are told, when the author moved it. */
  tellHandlers?: NotificationKind;
}

/**
 * A complaint's status moves (ADR 0042). Each one, in one transaction:
 * the caller's account row, then the complaint's row; the rules table is
 * asked after the lock; the row moves, the move is appended to the
 * history, audited by codes, and the author is told of every status
 * change the staff make.
 */
@Injectable()
export class ComplaintStatusService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly access: ComplaintAccess,
    private readonly audit: AuditService,
    private readonly notices: ComplaintNotices,
  ) {}

  /** Staff take a filed complaint in hand. */
  review(id: string): Promise<NeighbourComplaint> {
    return this.run(id, 'staff', {
      action: 'review',
      to: 'under_review',
      side: 'staff',
      audit: 'neighbour_complaint.review_started',
      tellAuthor: 'neighbour_complaint.under_review',
    });
  }

  /** Staff are bringing the two sides to an arrangement. */
  mediate(id: string): Promise<NeighbourComplaint> {
    return this.run(id, 'staff', {
      action: 'mediate',
      to: 'mediation',
      side: 'staff',
      audit: 'neighbour_complaint.mediation_started',
      tellAuthor: 'neighbour_complaint.in_mediation',
    });
  }

  resolve(id: string, reason: string | undefined): Promise<NeighbourComplaint> {
    const reasonCode = requireReasonCodeOnly(
      reason,
      REASON_CODES.neighbourComplaintResolve,
    );
    return this.run(id, 'staff', {
      action: 'resolve',
      to: 'resolved',
      side: 'staff',
      reasonCode,
      audit: 'neighbour_complaint.resolved',
      tellAuthor: 'neighbour_complaint.resolved',
    });
  }

  /** Staff dismiss it: `unfounded` is one of the reasons. */
  dismiss(id: string, reason: string | undefined): Promise<NeighbourComplaint> {
    const reasonCode = requireReasonCodeOnly(
      reason,
      REASON_CODES.neighbourComplaintDismiss,
    );
    return this.run(id, 'staff', {
      action: 'dismiss',
      to: 'dismissed',
      side: 'staff',
      reasonCode,
      audit: 'neighbour_complaint.dismissed',
      tellAuthor: 'neighbour_complaint.dismissed',
    });
  }

  /** The author takes it back, before the unit has been told anything. */
  withdraw(id: string): Promise<NeighbourComplaint> {
    return this.run(id, 'author', {
      action: 'withdraw',
      to: 'dismissed',
      side: 'resident',
      reasonCode: REASON_CODES.neighbourComplaintSystemClose[0],
      audit: 'neighbour_complaint.withdrawn',
      tellHandlers: 'neighbour_complaint.withdrawn',
    });
  }

  private run(
    id: string,
    audience: 'author' | 'staff',
    move: Move,
  ): Promise<NeighbourComplaint> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const complaint = await this.access.load(tx, id, audience, {
        lock: true,
      });
      assertCan(complaint, move.action);
      return this.move(tx, complaint, move, await dbNow(tx));
    });
  }

  /**
   * Under the complaint's lock, after the rules said yes: the row, its
   * history, the audit row and the notices. Also what the notice service
   * calls when the notice moves the status.
   */
  async move(
    tx: TenantTxClient,
    complaint: NeighbourComplaint,
    move: Omit<Move, 'action'>,
    now: Date,
    metadata: Record<string, string | number> = {},
  ): Promise<NeighbourComplaint> {
    const closing = move.to === 'resolved' || move.to === 'dismissed';
    const updated = await tx.neighbourComplaint.update({
      where: { id: complaint.id },
      data: {
        status: move.to,
        lastActivityAt: now,
        ...(closing
          ? {
              closedAt: now,
              closeReason: move.reasonCode,
              closedBySide: move.side,
            }
          : {}),
      },
    });
    await tx.neighbourComplaintStatusChange.create({
      data: {
        id: newId(),
        tenantId: complaint.tenantId,
        complaintId: complaint.id,
        fromStatus: complaint.status,
        toStatus: move.to,
        actorId: this.ctx.accountId,
        actorSide: move.side,
        reasonCode: closing ? move.reasonCode : null,
        createdAt: now,
      },
    });
    await this.audit.record(tx, {
      action: move.audit,
      targetId: complaint.id,
      metadata: {
        complaintNumber: complaint.number,
        from: complaint.status,
        to: move.to,
        ...(closing ? { reasonCode: move.reasonCode! } : {}),
        ...metadata,
      },
    });
    if (move.tellAuthor)
      await this.notices.toAuthor(tx, updated, move.tellAuthor);
    if (move.tellHandlers)
      await this.notices.toHandlers(
        tx,
        updated,
        move.tellHandlers,
        this.ctx.accountId,
      );
    return updated;
  }
}
