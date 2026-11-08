import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { ticketNumber } from '../tickets/ticket-rules';

/**
 * A technician's location in their personal-data export (ADR 0036, 0090),
 * `field-team/location.json`: every consent they gave (when given and
 * revoked, by whom) and the points kept now (the moment, the ticket by
 * number, where, how sure, when).
 */
@Injectable()
export class FieldLocationExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('technician_location', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const out = await this.tenantTx.withTenantTx(async (tx) => {
      const consents = await tx.technicianLocationConsent.findMany({
        where: { accountId: me },
        orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
      });
      const points = await tx.technicianLocation.findMany({
        where: { accountId: me },
        orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
      });
      const tickets = new Map(
        (points.length
          ? await tx.ticket.findMany({
              where: {
                id: { in: [...new Set(points.map((p) => p.ticketId))] },
              },
              select: { id: true, number: true },
            })
          : []
        ).map((t) => [t.id, ticketNumber(t.number)]),
      );
      return {
        consents: consents.map((c) => ({
          grantedAt: c.grantedAt,
          revokedAt: c.revokedAt,
          revokedBy: c.revokedBy,
        })),
        points: points.map((p) => ({
          moment: p.moment,
          ticket: tickets.get(p.ticketId) ?? null,
          latitude: p.latitude.toNumber(),
          longitude: p.longitude.toNumber(),
          accuracyMeters: p.accuracyM,
          capturedAt: p.capturedAt,
        })),
      };
    });
    if (out.consents.length || out.points.length)
      yield { path: 'field-team/location.json', json: out };
  }
}
