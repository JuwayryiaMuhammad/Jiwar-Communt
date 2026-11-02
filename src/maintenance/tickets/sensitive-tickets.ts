import { Injectable } from '@nestjs/common';
import { Prisma, type Ticket } from '@prisma/client';
import { PermissionsService } from '../../core/access/permissions.service';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/** How a staff reader came to a sensitive ticket (the log's `via`). */
export type SensitiveVia = 'detail' | 'list' | 'export' | 'search';

/**
 * Sensitive tickets (ADR 0081), written once for every read path: who may
 * see one among the compound's tickets, the filters that leave it out for
 * everyone else, and the log of every staff read.
 *
 * - A staff reader sees a sensitive ticket only holding `tickets.sensitive`
 *   (the role's set, cached by its version, ADR 0010: no query of its own);
 *   outside a signed-in request (a sweep) nobody does.
 * - The technician holding it reads it as their own work, and the residents
 *   it is theirs as before: neither needs the permission. Both staff sides'
 *   reads are logged, never a resident's.
 * - The filters: `where()` for Prisma, `sql()` for raw SQL on any alias.
 */
@Injectable()
export class SensitiveTickets {
  constructor(
    private readonly ctx: RequestContext,
    private readonly permissions: PermissionsService,
    private readonly staff: StaffRecipients,
  ) {}

  /** Whether the caller may see sensitive tickets among the compound's. */
  async mayRead(): Promise<boolean> {
    if (!this.ctx.accountIdOrNull()) return false;
    return this.permissions.has('tickets.sensitive');
  }

  /** The Prisma filter to AND into a staff list of tickets. */
  async where(): Promise<Prisma.TicketWhereInput> {
    return (await this.mayRead()) ? {} : { sensitive: false };
  }

  /** The same as SQL on `alias` (a `tickets` row): none, or `NOT alias.sensitive`. */
  async sql(alias = 't'): Promise<Prisma.Sql[]> {
    return (await this.mayRead())
      ? []
      : [Prisma.sql`NOT ${Prisma.raw(`"${alias}"`)}.sensitive`];
  }

  /**
   * Logs the caller's read of the sensitive ones among `tickets`, one row
   * each, in the reading transaction. Nothing for a resident, nothing
   * outside a request, nothing when none is sensitive.
   */
  async logReads(
    tx: TenantTxClient,
    tickets: readonly Pick<Ticket, 'id' | 'sensitive'>[],
    via: SensitiveVia,
  ): Promise<void> {
    const me = this.ctx.accountIdOrNull();
    const ids = [
      ...new Set(tickets.filter((t) => t.sensitive).map((t) => t.id)),
    ];
    if (!me || !ids.length) return;
    if (!['staff', 'manager'].includes(this.ctx.accountType)) return;
    await tx.$executeRaw`
      INSERT INTO ticket_sensitive_reads (id, tenant_id, ticket_id, account_id, via, read_at)
      SELECT gen_random_uuid(), t.tenant_id, t.id, ${me}::uuid, ${via},
             date_trunc('milliseconds', clock_timestamp())
        FROM tickets t
       WHERE t.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`;
  }

  /**
   * Who among `ids` may be told of a sensitive ticket: anyone not staff
   * (the residents it is theirs), its technician, and the staff holding
   * `tickets.sensitive` now. All of `ids` for a ticket that is not one.
   */
  async recipients(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'sensitive' | 'technicianId'>,
    accounts: readonly { id: string; type: string }[],
  ): Promise<string[]> {
    if (!ticket.sensitive) return accounts.map((a) => a.id);
    const holders = new Set(
      (await this.staff.holding(tx, 'tickets.sensitive')).map((r) => r.id),
    );
    return accounts
      .filter(
        (a) =>
          !['staff', 'manager'].includes(a.type) ||
          a.id === ticket.technicianId ||
          holders.has(a.id),
      )
      .map((a) => a.id);
  }
}
