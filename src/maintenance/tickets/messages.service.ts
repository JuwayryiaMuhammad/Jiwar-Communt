import { Injectable } from '@nestjs/common';
import type { Ticket, TicketMessage } from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * A ticket's thread (ADR 0032): where the people on a ticket coordinate,
 * instead of phone numbers. Bodies are content: never audited, never in a
 * notification, and nulled when their sender is erased.
 */
@Injectable()
export class MessagesService {
  /** One message, in the caller's transaction (the caller checked access). */
  write(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'tenantId'>,
    senderId: string,
    body: string,
    internal: boolean,
  ): Promise<TicketMessage> {
    return tx.ticketMessage.create({
      data: {
        id: newId(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        senderId,
        body,
        internal,
      },
    });
  }
}
