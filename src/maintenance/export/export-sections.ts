import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { MessagesService } from '../tickets/messages.service';
import { ticketNumber } from '../tickets/ticket-rules';
import { TicketsService } from '../tickets/tickets.service';
import { ResidentMessageView } from '../tickets/views/message.views';
import { ResidentTicketDetailView } from '../tickets/views/ticket.views';

/** Messages read per page while exporting a ticket. */
const MESSAGE_PAGE = 100;

/**
 * Maintenance's section of a personal-data export (ADR 0036): every
 * ticket the account opened or reported, one entry each
 * (`tickets/MT-000123.json`), as the resident's own detail shows it
 * (`GET /tickets/{id}`), with its messages as the resident's thread shows
 * them (`GET /tickets/{id}/messages`). Photos are the ticket's records, not
 * the account's files: only their count, never a URL.
 */
@Injectable()
export class MaintenanceExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly tickets: TicketsService,
    private readonly messages: MessagesService,
  ) {}

  onModuleInit(): void {
    this.sections.register('tickets', (s) => this.authored(s));
  }

  private async *authored(s: ExportSubject): AsyncIterable<ExportEntry> {
    const ids = await this.tenantTx.withTenantTx((tx) =>
      tx.ticket.findMany({
        where: {
          OR: [{ createdById: s.accountId }, { reporterId: s.accountId }],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, number: true },
      }),
    );
    for (const t of ids) {
      const detail = await this.tickets.detail(t.id, 'resident');
      const { photos, ...view } = ResidentTicketDetailView.fromDetail(
        detail,
        s.accountId,
      ) as ResidentTicketDetailView & { photos?: unknown[] };
      const thread: ResidentMessageView[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.messages.list(t.id, 'resident', {
          cursor,
          limit: MESSAGE_PAGE,
        });
        thread.push(...page.items.map((m) => ResidentMessageView.from(m)));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      yield {
        path: `tickets/${ticketNumber(t.number)}.json`,
        json: { ...view, photoCount: photos?.length ?? 0, messages: thread },
      };
    }
  }
}
