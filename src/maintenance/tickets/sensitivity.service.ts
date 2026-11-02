import { Injectable } from '@nestjs/common';
import type { TicketSensitiveRead } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { SensitiveTickets } from './sensitive-tickets';
import { TicketAccess } from './ticket-access';
import { TicketsService, type Person } from './tickets.service';

const READS = keysetCursor('readAt', 'desc');

export interface SensitiveReadsPage extends Page<TicketSensitiveRead> {
  people: Map<string, Person>;
}

/**
 * Marking a ticket sensitive and clearing it (ADR 0081). The dispatch
 * (`tickets.dispatch`) marks one, with a code from `ticketSensitive`; only
 * a holder of `tickets.sensitive` clears it (`ticketSensitiveClear`) and
 * reads who read it. Under the ticket's row lock, the caller's account
 * shared-locked first; a ticket already as asked is left as it is, without
 * an entry. A dispatcher without the permission loses the ticket the
 * moment it is marked: the next read, theirs too, answers TICKET_NOT_FOUND.
 */
@Injectable()
export class SensitivityService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly access: TicketAccess,
    private readonly sensitive: SensitiveTickets,
    private readonly tickets: TicketsService,
    private readonly audit: AuditService,
  ) {}

  async set(id: string, value: boolean, reasonCode?: string): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      value ? REASON_CODES.ticketSensitive : REASON_CODES.ticketSensitiveClear,
    );
    if (!value && !(await this.sensitive.mayRead()))
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Missing permission for this action',
      );
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, id, 'dispatch', {
        lock: true,
      });
      if (ticket.sensitive === value) return;
      await tx.ticket.update({ where: { id }, data: { sensitive: value } });
      await this.audit.record(tx, {
        action: 'ticket.sensitivity_changed',
        targetId: id,
        metadata: {
          sensitive: value,
          reasonCode: code,
          origin: ticket.origin,
        },
      });
    });
  }

  /** Who read a sensitive ticket, newest first, with their names. */
  reads(
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<SensitiveReadsPage> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, id, 'dispatch');
      const rows = await tx.ticketSensitiveRead.findMany({
        where: { AND: [{ ticketId: id }, ...READS.after(q.cursor)] },
        orderBy: READS.orderBy,
        take: limit + 1,
      });
      const page = READS.toPage(rows, limit);
      const people = new Map<string, Person>();
      await this.tickets.addPeople(
        tx,
        people,
        page.items.map((r) => r.accountId),
      );
      return { ...page, people };
    });
  }
}
