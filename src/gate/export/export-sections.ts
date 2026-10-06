import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';

/**
 * The gate's sections of a personal-data export (ADR 0036):
 * - `visitor-passes.json`: the passes the account issued, with exactly
 *   `id`, `unitCode`, `kind`, `partySize`, `validFrom`, `validUntil`,
 *   `schedule`, `status`, `usedAt`, `cancelledAt`, `cancelReasonCode`,
 *   `createdAt` and `visitorName` (the name the account typed, while the
 *   pass's visitor details still exist, ADR 0028) — never a code, a QR,
 *   or the visitor's phone;
 * - `entry-credentials.json`: the phones the account registered for its
 *   entry QR: `id`, `deviceName` (while live), `createdAt`, `revokedAt`,
 *   `revokeReason` — never a secret.
 */
@Injectable()
export class GateExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('visitor_passes', (s) => this.passes(s));
    this.sections.register('entry_credentials', (s) => this.credentials(s));
  }

  private async *passes(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.visitorPass.findMany({
        where: { hostAccountId: s.accountId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          partySize: true,
          validFrom: true,
          validUntil: true,
          schedule: true,
          status: true,
          usedAt: true,
          cancelledAt: true,
          cancelReasonCode: true,
          createdAt: true,
          unit: { select: { code: true } },
          visitorDetails: { select: { fullName: true } },
        },
      }),
    );
    yield {
      path: 'visitor-passes.json',
      json: rows.map((p) => ({
        id: p.id,
        unitCode: p.unit.code,
        kind: p.kind,
        partySize: p.partySize,
        validFrom: p.validFrom,
        validUntil: p.validUntil,
        schedule: p.schedule,
        status: p.status,
        usedAt: p.usedAt,
        cancelledAt: p.cancelledAt,
        cancelReasonCode: p.cancelReasonCode,
        createdAt: p.createdAt,
        visitorName: p.visitorDetails?.fullName ?? null,
      })),
    };
  }

  private async *credentials(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.entryCredential.findMany({
        where: { accountId: s.accountId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          deviceName: true,
          createdAt: true,
          revokedAt: true,
          revokeReason: true,
        },
      }),
    );
    yield { path: 'entry-credentials.json', json: rows };
  }
}
