import { Injectable } from '@nestjs/common';
import type { TicketAttachment, TicketAttachmentKind } from '@prisma/client';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { MaintenanceSettingsService } from '../settings/maintenance-settings.service';
import { TicketAccess } from './ticket-access';
import { WORK_PHOTOS_PER_CYCLE } from './ticket-limits';
import { assertCan } from './ticket-rules';
import { photoLimit, TicketsService } from './tickets.service';

/**
 * Photos on a ticket (ADR 0032). The reporter or creator adds report
 * photos while the ticket is open, up to the compound's `maxReportPhotos`;
 * the technician adds before and after photos while working, up to
 * WORK_PHOTOS_PER_CYCLE per cycle. Counted under the ticket's row lock, so
 * parallel uploads cannot pass a cap together. A photo is never removed.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly access: TicketAccess,
    private readonly tickets: TicketsService,
    private readonly settings: MaintenanceSettingsService,
  ) {}

  addReport(ticketId: string, fileId: string): Promise<TicketAttachment> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, ticketId, 'resident', {
        lock: true,
      });
      this.access.requireParty(ticket);
      await this.access.requireTickets(tx, ticket);
      assertCan(ticket, 'reportPhoto');
      const { maxReportPhotos } = await this.settings.inTx(tx);
      const count = await tx.ticketAttachment.count({
        where: { ticketId, kind: 'report' },
      });
      if (count >= maxReportPhotos) throw photoLimit(maxReportPhotos);
      return this.tickets.attach(tx, ticket, fileId, 'report', 'fileId');
    });
  }

  addWork(
    ticketId: string,
    fileId: string,
    kind: Exclude<TicketAttachmentKind, 'report'>,
  ): Promise<TicketAttachment> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, ticketId, 'technician', {
        lock: true,
      });
      assertCan(ticket, 'workPhoto');
      const count = await tx.ticketAttachment.count({
        where: {
          ticketId,
          cycle: ticket.cycle,
          kind: { in: ['before', 'after'] },
        },
      });
      if (count >= WORK_PHOTOS_PER_CYCLE)
        throw photoLimit(WORK_PHOTOS_PER_CYCLE);
      return this.tickets.attach(tx, ticket, fileId, kind, 'fileId');
    });
  }
}
