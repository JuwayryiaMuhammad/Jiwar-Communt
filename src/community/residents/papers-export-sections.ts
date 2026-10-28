import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const ref = (prefix: string, n: number) =>
  `${prefix}-${String(n).padStart(6, '0')}`;

/**
 * The unit's papers in a personal-data export (ADR 0036, 0062, 0063), as
 * records, never files:
 * - `contracts.json`: the contracts the account is a party to (through
 *   any of its occupancies, ended ones too): reference, unit, kind, dates,
 *   status, whether a scan is kept;
 * - `unit-documents.json`: the vault documents it uploaded, and the
 *   private ones of its occupancies: unit, kind, title, visibility, the
 *   warranty's end, when filed and deleted;
 * - `registrations.json`: its registration requests still kept (the one
 *   approved into this account; a decided request keeps no personal
 *   data): unit, capacity, status, dates;
 * - `moves.json`: the moves of its occupancies, with the steps ticked;
 * - `proxies.json`: the proxies its occupancies appointed and the places
 *   it holds as a proxy: unit, side, scopes, status, dates — never the
 *   other person's name or document.
 */
@Injectable()
export class PapersExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('contracts', (s) => this.contracts(s));
    this.sections.register('unit-documents', (s) => this.documents(s));
    this.sections.register('registrations', (s) => this.registrations(s));
    this.sections.register('moves', (s) => this.moves(s));
    this.sections.register('proxies', (s) => this.proxies(s));
  }

  private async *contracts(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.unitContract.findMany({
        where: { parties: { some: { occupancy: { accountId: s.accountId } } } },
        orderBy: { number: 'asc' },
        include: {
          unit: { select: { code: true } },
          renewedBy: { select: { voidedAt: true } },
        },
      }),
    );
    yield {
      path: 'contracts.json',
      json: rows.map((c) => ({
        reference: ref('CT', c.number),
        unitCode: c.unit.code,
        kind: c.kind,
        signedOn: day(c.signedOn),
        startsOn: day(c.startsOn),
        endsOn: day(c.endsOn),
        noticeDays: c.noticeDays,
        status: c.voidedAt
          ? 'voided'
          : c.renewedBy.some((r) => !r.voidedAt)
            ? 'renewed'
            : 'live',
        hasFile: c.fileId !== null,
      })),
    };
  }

  private async *documents(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.unitDocument.findMany({
        where: {
          OR: [
            { uploadedBy: s.accountId },
            {
              visibility: 'private',
              ownerOccupancy: { accountId: s.accountId },
            },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { unit: { select: { code: true } } },
      }),
    );
    yield {
      path: 'unit-documents.json',
      json: rows.map((d) => ({
        id: d.id,
        unitCode: d.unit.code,
        kind: d.kind,
        title: d.title,
        visibility: d.visibility,
        expiresOn: day(d.expiresOn),
        createdAt: d.createdAt,
        deletedAt: d.deletedAt,
      })),
    };
  }

  private async *registrations(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.residentRegistration.findMany({
        where: { approvedAccountId: s.accountId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    yield {
      path: 'registrations.json',
      json: rows.map((r) => ({
        unitCode: r.unitCode,
        occupancyType: r.occupancyType,
        status: r.status,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
      })),
    };
  }

  private async *moves(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.unitMove.findMany({
        where: { occupancy: { accountId: s.accountId } },
        orderBy: { number: 'asc' },
        include: {
          unit: { select: { code: true } },
          steps: { select: { step: true, doneAt: true } },
        },
      }),
    );
    yield {
      path: 'moves.json',
      json: rows.map((m) => ({
        reference: ref('MV', m.number),
        unitCode: m.unit.code,
        direction: m.direction,
        plannedOn: day(m.plannedOn),
        status: m.status,
        doneAt: m.doneAt,
        cancelledAt: m.cancelledAt,
        cancelReason: m.cancelReason,
        steps: m.steps.map((x) => ({ step: x.step, doneAt: x.doneAt })),
      })),
    };
  }

  private async *proxies(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.unitProxy.findMany({
        where: {
          OR: [
            { appointedBy: { accountId: s.accountId } },
            { accountId: s.accountId },
          ],
        },
        orderBy: { createdAt: 'asc' },
        include: {
          unit: { select: { code: true } },
          appointedBy: { select: { accountId: true } },
        },
      }),
    );
    yield {
      path: 'proxies.json',
      json: rows.map((p) => ({
        unitCode: p.unit.code,
        side: p.accountId === s.accountId ? 'held' : 'appointed',
        scopes: p.scopes,
        status: p.status,
        expiresAt: p.expiresAt,
        acceptedAt: p.acceptedAt,
        endedAt: p.endedAt,
        endReason: p.endReason,
      })),
    };
  }
}
