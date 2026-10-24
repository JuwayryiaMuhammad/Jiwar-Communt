import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { NeighbourComplaintNotice } from '@prisma/client';
import { CommunityNeighboursPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { DecisionAppeals } from '../../core/decision-appeals/decision-appeals';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';

/**
 * A neighbour notice appealed to the management (ADR 0059), registered with
 * core's DecisionAppeals. Those it went to appeal it, while they still
 * answer for the unit as they did then (as they read it): to anyone else it
 * is not found. An overturn withdraws it, once; the notice, its recipients
 * and the complaint otherwise stay as they are.
 */
@Injectable()
export class NoticeDecisionAppeals implements OnModuleInit {
  constructor(
    private readonly registry: DecisionAppeals,
    private readonly community: CommunityNeighboursPort,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registry.register('neighbour_notice', {
      resolve: async (tx, id, accountId) => {
        const n = await this.lock(tx, id);
        if (!n) return null;
        const complaint = await tx.neighbourComplaint.findUniqueOrThrow({
          where: { id: n.complaintId },
          select: { targetUnitId: true },
        });
        const recipient = await tx.neighbourComplaintNoticeRecipient.findFirst({
          where: { noticeId: id, accountId },
          select: { accountId: true },
        });
        if (
          !recipient ||
          !(await this.community.stillRecipient(
            tx,
            complaint.targetUnitId,
            accountId,
            n.recipientKind,
            await dbNow(tx),
          ))
        )
          return null;
        return {
          unitId: complaint.targetUnitId,
          decidedAt: n.createdAt,
          deciderId: n.sentById,
          mayAppeal: true,
          refused: n.withdrawnAt ? 'not_in_force' : null,
        };
      },
      lodged: () => Promise.resolve(),
      closed: async (tx, id, outcome, ev) => {
        if (outcome !== 'overturned') return { effect: 'none' };
        const n = await this.lock(tx, id);
        if (!n || n.withdrawnAt) return { effect: 'none', reason: 'changed' };
        await tx.neighbourComplaintNotice.update({
          where: { id },
          data: { withdrawnAt: ev.now },
        });
        await this.audit.record(tx, {
          action: 'neighbour_complaint.notice_withdrawn',
          targetId: n.complaintId,
          metadata: { noticeId: id, appealId: ev.appealId },
        });
        return { effect: 'applied' };
      },
      describe: async (tx, id) => {
        const n = await tx.neighbourComplaintNotice.findUnique({
          where: { id },
          include: {
            complaint: { select: { category: { select: { key: true } } } },
          },
        });
        if (!n) return null;
        return {
          categoryKey: n.complaint.category.key,
          recipientKind: n.recipientKind,
          sentAt: n.createdAt,
          withdrawnAt: n.withdrawnAt,
        };
      },
    });
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<NeighbourComplaintNotice | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM neighbour_complaint_notices WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.neighbourComplaintNotice.findUniqueOrThrow({ where: { id } });
  }
}
