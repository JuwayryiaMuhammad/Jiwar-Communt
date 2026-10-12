import { Injectable } from '@nestjs/common';
import type { ManagementRequest } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { afterMessage } from './request-rules';

/** What moved a request without anyone choosing a status. */
export type ProgressCause = 'reply' | 'start' | 'appointment';

/**
 * How a request moves when something happens on it (ADR 0039), in the
 * caller's transaction and under the request's lock: the status, the
 * response clock, the activity time, and the audit row of the move. Codes
 * and numbers only: never what was written.
 */
@Injectable()
export class RequestProgress {
  constructor(private readonly audit: AuditService) {}

  /**
   * After a message the author reads (never a note), at `now`:
   * - a staff message is a response: the cycle's first one stops the clock;
   * - an official reply answers the request, again each time (the auto-close
   *   wait starts over);
   * - the author's message puts an answered request back in hand.
   */
  async afterMessage(
    tx: TenantTxClient,
    request: ManagementRequest,
    message: { side: 'resident' | 'staff'; official: boolean },
    now: Date,
  ): Promise<ManagementRequest> {
    const status = afterMessage(request.status, message);
    const answers = message.side === 'staff' && message.official;
    const updated = await tx.managementRequest.update({
      where: { id: request.id },
      data: {
        status,
        lastActivityAt: now,
        ...(message.side === 'staff' && request.firstResponseAt === null
          ? { firstResponseAt: now }
          : {}),
        ...(answers ? { answeredAt: now } : {}),
      },
    });
    const facts = { requestNumber: request.number, cycle: request.cycle };
    if (answers)
      await this.audit.record(tx, {
        action: 'management_request.answered',
        targetId: request.id,
        metadata: { ...facts, fromStatus: request.status },
      });
    else if (status !== request.status)
      await this.audit.record(tx, {
        action:
          message.side === 'staff'
            ? 'management_request.started'
            : 'management_request.resumed',
        targetId: request.id,
        metadata:
          message.side === 'staff'
            ? { ...facts, by: 'reply' satisfies ProgressCause }
            : { ...facts, fromStatus: request.status },
      });
    return updated;
  }

  /**
   * A staff response that is not a message (taking the request in hand,
   * confirming or proposing an appointment): the cycle's first one stops
   * the clock, and an open request is in hand from then on.
   */
  async responded(
    tx: TenantTxClient,
    request: ManagementRequest,
    cause: Exclude<ProgressCause, 'reply'>,
    now: Date,
  ): Promise<ManagementRequest> {
    const starts = request.status === 'open';
    const updated = await tx.managementRequest.update({
      where: { id: request.id },
      data: {
        lastActivityAt: now,
        ...(starts ? { status: 'in_progress' as const } : {}),
        ...(request.firstResponseAt === null ? { firstResponseAt: now } : {}),
      },
    });
    if (starts)
      await this.audit.record(tx, {
        action: 'management_request.started',
        targetId: request.id,
        metadata: {
          requestNumber: request.number,
          cycle: request.cycle,
          by: cause,
        },
      });
    return updated;
  }
}
