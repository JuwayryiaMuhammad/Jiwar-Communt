import { Injectable } from '@nestjs/common';
import type {
  ManagementRequest,
  ManagementRequestMessage,
  ManagementSide,
} from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

export const MESSAGE_LENGTH = { min: 1, max: 4000 } as const;

export interface NewMessage {
  side: ManagementSide;
  body: string;
  /** A staff note: no resident route returns it. */
  internal?: boolean;
  /** Chosen by staff when sending: the request is answered. */
  official?: boolean;
}

/**
 * A request's conversation (ADR 0039). A message is written once and never
 * changes: the table's trigger refuses everything but the erasure that
 * clears its body.
 */
@Injectable()
export class MessagesService {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * Inside the caller's transaction, under the request's lock: the row, by
   * the caller, in the request's current cycle and at `at` (the database's
   * clock, read after the lock).
   */
  write(
    tx: TenantTxClient,
    request: Pick<ManagementRequest, 'id' | 'tenantId' | 'cycle'>,
    message: NewMessage,
    at: Date,
  ): Promise<ManagementRequestMessage> {
    return tx.managementRequestMessage.create({
      data: {
        id: newId(),
        tenantId: request.tenantId,
        requestId: request.id,
        senderId: this.ctx.accountId,
        senderSide: message.side,
        internal: message.side === 'staff' && message.internal === true,
        official: message.side === 'staff' && message.official === true,
        body: message.body,
        cycle: request.cycle,
        createdAt: at,
      },
    });
  }
}
