import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ManagementRequestEscalation } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { isOverdue } from './request-rules';

export const ESCALATION_SWEEP = 'management.escalation';
/** Often enough that "overdue" is noticed within minutes. */
const ESCALATION_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 500;

/**
 * Escalation (ADR 0039, the rule of ADR 0038 for tickets): a request is
 * escalated only when its response is overdue — the cycle's due time has
 * passed and staff have not responded in it — and at most once per cycle.
 * A cycle starts when the request is opened and each time it is reopened;
 * its clock stops at the first staff response. Wall-clock time: business
 * hours are not counted.
 *
 * Nobody asks for it: a sweep finds the overdue requests. "Once" is three
 * things that agree: the row's `escalated_at`, read again under its lock;
 * the request's row lock itself; and the unique index on (request, cycle)
 * of the append-only escalations table as the backstop.
 */
@Injectable()
export class RequestEscalation implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(ESCALATION_SWEEP, (now) => this.escalateDue(now), {
      intervalMs: ESCALATION_INTERVAL_MS,
    });
  }

  /**
   * One transaction per request: the row is taken with SKIP LOCKED and
   * judged again under its lock by the one definition of overdue, so a
   * reply or a close holding the row wins and the sweep leaves it. Run
   * twice, or on two instances at once, a cycle is escalated once.
   */
  escalateDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const due = await tx.managementRequest.findMany({
          where: {
            status: { in: ['open', 'in_progress'] },
            firstResponseAt: null,
            escalatedAt: null,
            responseDueAt: { lte: now },
          },
          orderBy: [{ responseDueAt: 'asc' }, { id: 'asc' }],
          take: SWEEP_BATCH,
          select: { id: true },
        });
        return due.map((r) => r.id);
      },
      async (tx, tenantId, id) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM management_requests
           WHERE id = ${id}::uuid AND escalated_at IS NULL
             FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const request = await tx.managementRequest.findUniqueOrThrow({
          where: { id },
        });
        if (!isOverdue(request, now)) return 0;
        await tx.managementRequestEscalation.create({
          data: {
            id: newId(),
            tenantId,
            requestId: id,
            cycle: request.cycle,
            dueAt: request.responseDueAt,
            createdAt: now,
          },
        });
        await tx.managementRequest.update({
          where: { id },
          data: { escalatedAt: now },
        });
        await this.audit.record(tx, {
          action: 'management_request.escalated',
          targetId: id,
          metadata: { requestNumber: request.number, cycle: request.cycle },
        });
        return 1;
      },
    );
  }

  /** A request's escalations, oldest first (staff only). */
  list(
    tx: TenantTxClient,
    requestId: string,
  ): Promise<ManagementRequestEscalation[]> {
    return tx.managementRequestEscalation.findMany({
      where: { requestId },
      orderBy: [{ cycle: 'asc' }],
    });
  }
}
