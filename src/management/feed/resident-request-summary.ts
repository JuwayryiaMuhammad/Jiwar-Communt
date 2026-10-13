import { Injectable } from '@nestjs/common';
import type { ManagementRequestStatus } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { requestNumber } from '../requests/request-rules';

/** A resident's requests to the management in two facts (ADR 0040): codes only. */
export interface RequestSummary {
  /** Requests not closed. */
  open: number;
  /** The open request that moved last, if any. */
  latest: {
    id: string;
    number: string;
    status: ManagementRequestStatus;
  } | null;
}

/**
 * What the daily brief reads of a resident's management requests (ADR
 * 0040): how many are open, and where the latest stands. A request is its
 * author's alone, as everywhere (ADR 0039), and nothing of it is read but
 * its number and status.
 */
@Injectable()
export class ResidentRequestSummary {
  async of(tx: TenantTxClient, accountId: string): Promise<RequestSummary> {
    const where = {
      authorId: accountId,
      status: { not: 'closed' as const },
    };
    const open = await tx.managementRequest.count({ where });
    const latest = open
      ? await tx.managementRequest.findFirst({
          where,
          orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
          select: { id: true, number: true, status: true },
        })
      : null;
    return {
      open,
      latest: latest && {
        id: latest.id,
        number: requestNumber(latest.number),
        status: latest.status,
      },
    };
  }
}
