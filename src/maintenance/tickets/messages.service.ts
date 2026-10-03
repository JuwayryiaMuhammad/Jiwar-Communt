import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AccountType, Ticket, TicketMessage } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TicketAccess, type Audience } from './ticket-access';
import { MESSAGE_LENGTH } from './ticket-limits';
import { TicketNotices } from './ticket-notices';
import { assertCan } from './ticket-rules';

export const MESSAGE_RESOURCE = 'ticket_message';

export interface Sender {
  id: string;
  fullName: string | null;
  status: string;
  type: AccountType;
}

export interface MessageRead {
  message: TicketMessage;
  sender: Sender;
}

/** Oldest first: a thread reads top to bottom. */
const PAGE = keysetCursor('createdAt', 'asc');

/**
 * A ticket's thread (ADR 0032): where the people on a ticket coordinate,
 * instead of phone numbers. The reporter, the creator, the unit's primary,
 * the current technician and dispatchers post; an `internal` message is
 * for staff (the technician and dispatch) and never reaches a resident.
 *
 * Bodies are content: never audited, never in a notification. An erasure
 * nulls its person's bodies and sets `deleted_at`; the sender stays a
 * pointer to the tombstone, and views render it as erased (ADR 0023).
 */
@Injectable()
export class MessagesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly notices: TicketNotices,
    private readonly community: CommunityMaintenancePort,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(MESSAGE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const m = await tx.ticketMessage.findUniqueOrThrow({ where: { id } });
        return { id: m.id, createdAt: m.createdAt };
      }),
    );
    // Erasure (ADR 0023): the person's words go, in the erasure's
    // transaction, which locked the account row first; a post or a
    // confirmation in flight holds that row shared, so none lands after.
    this.lifecycle.onErasing(async (tx, account) => {
      await tx.$executeRaw`
        UPDATE ticket_messages
           SET body = NULL, deleted_at = COALESCE(deleted_at, now())
         WHERE sender_account_id = ${account.id}::uuid AND body IS NOT NULL`;
      await tx.$executeRaw`
        UPDATE ticket_feedback SET comment = NULL
         WHERE author_account_id = ${account.id}::uuid AND comment IS NOT NULL`;
      return [];
    });
  }

  /** The thread as `audience` may read it: no internal message for residents. */
  list(
    ticketId: string,
    audience: Audience,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<MessageRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, ticketId, audience);
      const limit = clampLimit(q.limit);
      const rows = await tx.ticketMessage.findMany({
        where: {
          AND: [
            { ticketId },
            audience === 'resident' ? { internal: false } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        include: {
          sender: {
            select: { id: true, fullName: true, status: true, type: true },
          },
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: page.items.map(({ sender, ...message }) => ({
          message,
          sender,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * Posts to the thread, if the caller is on the ticket and it is not
   * closed or cancelled. Everyone else who can see the message is told,
   * without its body.
   */
  post(
    ticketId: string,
    audience: Audience,
    body: string,
    internal = false,
  ): Promise<TicketMessage> {
    const text = body.trim();
    if (!text)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Empty message', {
        fields: [
          {
            field: 'body',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { ...MESSAGE_LENGTH },
          },
        ],
      });
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: MESSAGE_RESOURCE, id });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, audience, {
        lock: true,
      });
      if (audience === 'resident') await this.access.requireTickets(tx, ticket);
      assertCan(ticket, 'message');
      const message = await tx.ticketMessage.create({
        data: {
          id,
          tenantId: ticket.tenantId,
          ticketId,
          senderId: me,
          body: text,
          internal: audience !== 'resident' && internal,
        },
      });
      await this.notices.send(
        tx,
        await this.readers(tx, ticket, message.internal),
        'ticket.message',
        ticket,
        {},
        me,
      );
      return message;
    });
  }

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

  /** Who may read a message on this ticket now. */
  private async readers(
    tx: TenantTxClient,
    ticket: Ticket,
    internal: boolean,
  ): Promise<(string | null)[]> {
    const staff = [
      ticket.technicianId,
      ...(await this.notices.dispatchers(tx)),
    ];
    if (internal) return staff;
    return [
      ...staff,
      ticket.reporterId,
      ticket.createdById,
      ticket.unitId ? await this.community.primaryOf(tx, ticket.unitId) : null,
    ];
  }
}
