import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { ticketNumber } from '../tickets/ticket-rules';

/**
 * A technician's calls for help in their personal-data export (ADR 0036,
 * 0078), `field-team/help-requests.json`: the calls they made (kind,
 * status, the ticket by number, their own note, when) and those they were
 * sent to help (kind, status, when). Never another's name or note.
 */
@Injectable()
export class HelpExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('technician_help', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const calls = await tx.technicianHelpRequest.findMany({
        where: { OR: [{ requesterId: me }, { helperId: me }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const tickets = new Map(
        (
          await tx.ticket.findMany({
            where: {
              id: {
                in: calls.flatMap((c) => (c.ticketId ? [c.ticketId] : [])),
              },
            },
            select: { id: true, number: true },
          })
        ).map((t) => [t.id, ticketNumber(t.number)]),
      );
      return calls.map((c) =>
        c.requesterId === me
          ? {
              role: 'caller',
              kind: c.kind,
              status: c.status,
              ticket: c.ticketId ? (tickets.get(c.ticketId) ?? null) : null,
              note: c.note,
              helped: c.helperId !== null,
              createdAt: c.createdAt,
              takenAt: c.takenAt,
              resolvedAt: c.resolvedAt,
              cancelledAt: c.cancelledAt,
            }
          : {
              role: 'helper',
              kind: c.kind,
              status: c.status,
              createdAt: c.createdAt,
              takenAt: c.takenAt,
              resolvedAt: c.resolvedAt,
            },
      );
    });
    if (rows.length)
      yield { path: 'field-team/help-requests.json', json: rows };
  }
}
