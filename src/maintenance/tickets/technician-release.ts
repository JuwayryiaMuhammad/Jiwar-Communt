import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { AvailabilityService } from '../dispatch/availability.service';
import { TicketLog } from './ticket-log';
import { TicketNotices } from './ticket-notices';
import { IN_HAND } from './ticket-rules';

/**
 * A technician who is deactivated, frozen or erased cannot work, so the
 * tickets in their hands go back to the dispatch queue (ADR 0032), in the
 * transaction of that change: a `released` assignment and a status row by
 * the system, and every dispatcher is told. Done work (completed, closed)
 * keeps its technician.
 */
@Injectable()
export class TechnicianRelease implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly log: TicketLog,
    private readonly notices: TicketNotices,
    private readonly availability: AvailabilityService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.leave(tx, account.id, 'account_deactivated');
      return [];
    });
    this.lifecycle.onFrozen((tx, account) =>
      this.leave(tx, account.id, 'account_frozen'),
    );
    this.lifecycle.onErasing(async (tx, account) => {
      await this.leave(tx, account.id, 'account_erased');
      return [];
    });
  }

  /**
   * The account can no longer work: it leaves the pool (availability, with
   * the reason) and its tickets in hand go back to the queue. The caller
   * holds the account's row. Reactivation does not undo the availability:
   * a technician opts in again.
   */
  private async leave(
    tx: TenantTxClient,
    accountId: string,
    reason: 'account_deactivated' | 'account_frozen' | 'account_erased',
  ): Promise<void> {
    await this.availability.markUnavailable(tx, accountId, reason);
    await this.release(tx, accountId);
  }

  async release(tx: TenantTxClient, technicianId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM tickets
       WHERE technician_account_id = ${technicianId}::uuid
         AND status::text = ANY(${[...IN_HAND]}::text[])
       ORDER BY id
         FOR UPDATE`;
    if (!rows.length) return;
    const dispatchers = await this.notices.dispatchers(tx);
    for (const { id } of rows) {
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
      await tx.ticket.update({
        where: { id },
        data: {
          status: 'new',
          holdReason: null,
          technicianId: null,
          assignedAt: null,
        },
      });
      await this.log.assignment(tx, ticket, {
        type: 'released',
        fromId: technicianId,
        toId: null,
        assignedById: null,
        reasonCode: 'technician_unavailable',
        cycle: ticket.cycle,
      });
      await this.log.status(tx, ticket, {
        from: ticket.status,
        to: 'new',
        actorId: null,
        reasonCode: 'technician_unavailable',
        cycle: ticket.cycle,
      });
      await this.notices.send(
        tx,
        dispatchers,
        'ticket.technician_unavailable',
        ticket,
      );
    }
  }
}
