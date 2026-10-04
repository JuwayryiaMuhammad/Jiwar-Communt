import { Injectable } from '@nestjs/common';
import type { Ticket, TicketPriority } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { ticketNumber } from './ticket-rules';

/** The ticket's own notification params, besides the kind's extras. */
type Extra = Record<string, string | number>;

/**
 * A ticket's notifications (ADR 0027, 0032), in the action's transaction.
 * Params are the ticket number, the unit code and codes (a status, a
 * priority, a category key): never the description, the common-area label
 * (free text), a message, or anyone's contact data.
 */
@Injectable()
export class TicketNotices {
  constructor(
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly community: CommunityMaintenancePort,
  ) {}

  /** Every account holding tickets.dispatch now (managers by default). */
  async dispatchers(tx: TenantTxClient): Promise<string[]> {
    return (await this.staff.holding(tx, 'tickets.dispatch')).map((r) => r.id);
  }

  /**
   * Tells the active accounts among `to`, never `except` (the one who
   * acted). The unit code rides along when the kind takes it.
   */
  async send(
    tx: TenantTxClient,
    to: readonly (string | null)[],
    kind: NotificationKind,
    ticket: Pick<Ticket, 'id' | 'number' | 'unitId'>,
    extra: Extra = {},
    except: string | null = null,
  ): Promise<void> {
    const ids = [...new Set(to)].filter(
      (id): id is string => id !== null && id !== except,
    );
    if (!ids.length) return;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
    });
    if (!active.length) return;
    const params: Extra = {
      ticketNumber: ticketNumber(ticket.number),
      ...extra,
    };
    if (ticket.unitId)
      params.unitCode = (
        await this.community.unitCodes(tx, [ticket.unitId])
      ).get(ticket.unitId)!;
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind, params, targetId: ticket.id },
    );
  }

  /**
   * A ticket is the technician's now (manual or automatic): its priority and
   * category code. Both assignment paths tell the technician the same way.
   */
  async assigned(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'number' | 'unitId' | 'categoryId'> & {
      priority: TicketPriority;
    },
    technicianId: string,
  ): Promise<void> {
    const category = await tx.ticketCategory.findUniqueOrThrow({
      where: { id: ticket.categoryId },
    });
    await this.send(tx, [technicianId], 'ticket.assigned', ticket, {
      priority: ticket.priority,
      categoryKey: category.key,
    });
  }

  /**
   * Nobody can take the queued ticket: every dispatcher is told, critically
   * for an emergency (ADR 0033).
   */
  async unassignable(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'number' | 'unitId' | 'categoryId'> & {
      priority: TicketPriority;
    },
  ): Promise<void> {
    const category = await tx.ticketCategory.findUniqueOrThrow({
      where: { id: ticket.categoryId },
    });
    await this.send(
      tx,
      await this.dispatchers(tx),
      ticket.priority === 'emergency'
        ? 'ticket.unassignable_emergency'
        : 'ticket.unassignable',
      ticket,
      { categoryKey: category.key },
    );
  }
}
