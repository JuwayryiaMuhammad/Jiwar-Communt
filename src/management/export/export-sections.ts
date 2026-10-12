import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { AppointmentView } from '../appointments/views/appointment.views';
import { MessagesService } from '../requests/messages.service';
import { requestNumber } from '../requests/request-rules';
import { RequestsService } from '../requests/requests.service';
import { ResidentRequestMessageView } from '../requests/views/message.views';
import { ResidentRequestDetailView } from '../requests/views/request.views';

/** Messages read per page while exporting a request. */
const MESSAGE_PAGE = 100;

/**
 * The management requests' section of a personal-data export (ADR 0036,
 * 0039): every request the account is the author of, one entry each
 * (`management-requests/MR-000123.json`), as the author's own detail shows
 * it (`GET /management-requests/{id}`, with the rating they gave), its
 * conversation as the author's thread shows it
 * (`GET /management-requests/{id}/messages`) and every appointment it had.
 *
 * It runs as the account and reads through the author's own services and
 * views, so a staff note cannot be in it: the author's thread never returns
 * one. Attachments are the request's records, not the account's files: only
 * their count per message, never a URL (as a ticket's photos).
 */
@Injectable()
export class ManagementExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly requests: RequestsService,
    private readonly messages: MessagesService,
  ) {}

  onModuleInit(): void {
    this.sections.register('management-requests', (s) => this.authored(s));
  }

  private async *authored(s: ExportSubject): AsyncIterable<ExportEntry> {
    const ids = await this.tenantTx.withTenantTx((tx) =>
      tx.managementRequest.findMany({
        where: { authorId: s.accountId },
        orderBy: { number: 'asc' },
        select: { id: true, number: true },
      }),
    );
    for (const r of ids) {
      // The live appointment is among `appointments` below, with the rest.
      const view: Partial<ResidentRequestDetailView> =
        ResidentRequestDetailView.fromDetail(await this.requests.detail(r.id));
      delete view.appointment;
      const thread: object[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.messages.list(r.id, 'resident', {
          cursor,
          limit: MESSAGE_PAGE,
        });
        for (const m of page.items) {
          const { attachments, ...message } =
            ResidentRequestMessageView.from(m);
          thread.push({ ...message, attachmentCount: attachments.length });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const appointments = await this.tenantTx.withTenantTx((tx) =>
        tx.managementAppointment.findMany({
          where: { requestId: r.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      );
      yield {
        path: `management-requests/${requestNumber(r.number)}.json`,
        json: {
          ...view,
          messages: thread,
          appointments: appointments.map((a) => AppointmentView.from(a)),
        },
      };
    }
  }
}
