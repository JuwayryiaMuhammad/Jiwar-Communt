import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { inspectionReference } from './inspection-requests.service';

/**
 * `inspection-requests.json` (ADR 0036, 0063): the inspections the account
 * asked for, of a closed unit it owns or looks after — unit, preferred day,
 * status and dates. Never the guard, the note or the photos: those are the
 * unit's report, read in the app.
 */
@Injectable()
export class InspectionExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.sections.register('inspection-requests', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.unitInspectionRequest.findMany({
        where: { requestedBy: s.accountId },
        orderBy: { createdAt: 'asc' },
      });
      const codes = await this.community.unitCodes(
        tx,
        found.map((r) => r.unitId),
      );
      return found.map((r) => ({
        reference: inspectionReference(r.number),
        unitCode: codes.get(r.unitId) ?? null,
        preferredOn: r.preferredOn.toISOString().slice(0, 10),
        status: r.status,
        createdAt: r.createdAt,
        scheduledAt: r.scheduledAt,
        doneAt: r.doneAt,
        cancelledAt: r.cancelledAt,
        cancelReason: r.cancelReason,
      }));
    });
    yield { path: 'inspection-requests.json', json: rows };
  }
}
