import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { ofDateColumn, ofDateColumnOrNull } from '../schedules/local-dates';

/**
 * A staff member's certificates in their personal-data export (ADR 0036,
 * 0090), `field-team/certificates.json`: each one's kind, title, issuer,
 * reference and days, live or removed. Never the paper itself, nor who
 * filed it.
 */
@Injectable()
export class CertificateExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('staff_certificates', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.staffCertificate.findMany({
        where: { accountId: s.accountId },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      }),
    );
    if (rows.length)
      yield {
        path: 'field-team/certificates.json',
        json: rows.map((c) => ({
          kind: c.kind,
          title: c.title,
          issuer: c.issuer,
          reference: c.reference,
          issuedOn: ofDateColumnOrNull(c.issuedOn),
          expiresOn: ofDateColumn(c.expiresOn),
          paperFiled: c.fileId !== null,
          addedAt: c.addedAt,
          removedAt: c.removedAt,
        })),
      };
  }
}
