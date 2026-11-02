import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PermissionsService } from '../access/permissions.service';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/cls/request-context';
import { toCsv } from '../common/csv';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { localDate, type LocalDate } from '../common/slots/day-slots';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { XLSX_TYPE } from '../files/purposes';
import { PdfRenderer } from '../pdf/pdf-renderer';
import { drawReportTable, reportLayout } from '../pdf/report-table';
import { TenantSettingsService } from '../tenant-settings/tenant-settings.service';
import { flatten, lineUp, type ReportResult } from './report-compare';
import {
  lastYearPeriod,
  previousPeriod,
  resolveReportPeriod,
  type ReportComparison,
  type ReportFormat,
} from './report-periods';
import {
  REPORT_MAX_ROWS,
  REPORT_READERS,
  StaffReports,
  type ReportDefinition,
  type ReportKey,
  type ReportPeriod,
} from './report-registry';
import { toXlsx } from './xlsx';

export const reportNotFound = () =>
  appError.notFound(ErrorCode.REPORT_NOT_FOUND, 'Report not found');

const notYours = (def: ReportDefinition) =>
  appError.forbidden(
    ErrorCode.REPORT_NOT_YOURS,
    'This report is read with its own permission',
    { params: { permission: def.permission } },
  );

/**
 * The grouping asked for, or the report's first: one of the report's own,
 * INVALID_VALUE otherwise.
 */
export function groupingOf(
  def: ReportDefinition,
  groupBy: string | null | undefined,
): string {
  const g = groupBy ?? def.groupBy[0];
  if (!def.groupBy.includes(g))
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Not one of the report’s groupings',
      {
        fields: [
          {
            field: 'groupBy',
            code: FieldErrorCode.INVALID_VALUE,
            params: { allowed: [...def.groupBy] },
          },
        ],
      },
    );
  return g;
}

/** A report in the catalog, as the caller may read it. */
export interface ReportCatalogEntry {
  key: ReportKey;
  title: { en: string; ar: string };
  permission: string;
  groupBy: readonly string[];
}

export interface ReportQuery {
  from?: string;
  to?: string;
  groupBy?: string;
  compare?: ReportComparison;
}

/** A drawn file: its bytes, type and name. */
export interface ReportFile {
  body: Buffer;
  contentType: string;
  name: string;
}

const TYPES: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: XLSX_TYPE,
  csv: 'text/csv',
};

/**
 * The curated reports (ADR 0086): the catalog by permission, a report on
 * screen, and a report as a PDF, a workbook or CSV, each read in one
 * tenant transaction (RLS), compared with the period before and/or the
 * same period a year earlier. A file is drawn on demand and audited by its
 * key, format and period; nothing of it is kept.
 */
@Injectable()
export class ReportsService implements OnApplicationBootstrap {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly registry: StaffReports,
    private readonly permissions: PermissionsService,
    private readonly settings: TenantSettingsService,
    private readonly globalDb: GlobalDbService,
    private readonly audit: AuditService,
    private readonly pdf: PdfRenderer,
    private readonly ctx: RequestContext,
  ) {}

  /** Every report has its domain's definition once the modules started. */
  onApplicationBootstrap(): void {
    const missing = this.registry.missing();
    if (missing.length)
      throw new Error(`Reports without a definition: ${missing.join(', ')}`);
    const readers: readonly string[] = REPORT_READERS;
    for (const r of this.registry.all())
      if (!readers.includes(r.permission))
        throw new Error(
          `Report ${r.key} is read by ${r.permission}, not a reader`,
        );
  }

  /** The reports the caller may read. */
  async catalog(): Promise<ReportCatalogEntry[]> {
    const held = await this.permissions.current();
    return this.registry
      .all()
      .filter((r) => held.has(r.permission))
      .map((r) => ({
        key: r.key,
        title: r.title,
        permission: r.permission,
        groupBy: r.groupBy,
      }));
  }

  /** The definition of `key`, if the caller holds its permission. */
  async readable(key: string): Promise<ReportDefinition> {
    const def = this.registry.get(key);
    if (!def) throw reportNotFound();
    if (!(await this.permissions.has(def.permission))) throw notYours(def);
    return def;
  }

  async read(key: string, q: ReportQuery): Promise<ReportResult> {
    const def = await this.readable(key);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today, timeZone } = await this.clock(tx);
      return this.build(tx, def, {
        period: resolveReportPeriod(q, today),
        groupBy: q.groupBy,
        compare: q.compare ?? 'none',
        today,
        timeZone,
      });
    });
  }

  async export(
    key: string,
    q: ReportQuery,
    format: ReportFormat,
  ): Promise<ReportFile> {
    const def = await this.readable(key);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today, timeZone, now } = await this.clock(tx);
      const result = await this.build(tx, def, {
        period: resolveReportPeriod(q, today),
        groupBy: q.groupBy,
        compare: q.compare ?? 'none',
        today,
        timeZone,
      });
      const file = await this.render(
        result,
        format,
        await this.compoundName(tx),
        now,
      );
      await this.audit.record(tx, {
        action: 'report.exported',
        targetId: this.ctx.txTenantId,
        metadata: {
          reportKey: def.key,
          format,
          from: result.period.from,
          to: result.period.to,
          groupBy: result.groupBy,
          compare: result.compare,
          rows: result.rows.length,
        },
      });
      return file;
    });
  }

  /** The compound's clock: the database's instant, its zone and its day. */
  async clock(
    tx: TenantTxClient,
    tenantId = this.ctx.txTenantId,
  ): Promise<{ now: Date; today: LocalDate; timeZone: string }> {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
      SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    const { timezone } = await this.settings.inTx(tx, tenantId);
    return { now, today: localDate(now, timezone), timeZone: timezone };
  }

  /**
   * A report over a period, lined up with the periods it is compared with,
   * in the caller's transaction. The grouping is one of the report's (its
   * first by default: INVALID_VALUE otherwise); more than REPORT_MAX_ROWS
   * rows in any period is REPORT_TOO_LARGE.
   */
  async build(
    tx: TenantTxClient,
    def: ReportDefinition,
    q: {
      period: ReportPeriod;
      groupBy?: string | null;
      compare: ReportComparison;
      today: LocalDate;
      timeZone: string;
    },
  ): Promise<ReportResult> {
    const groupBy = groupingOf(def, q.groupBy);
    const { columns, dimensions } = def.columns(groupBy);
    const one = async (period: ReportPeriod) => {
      const t = await def.read(tx, {
        period,
        groupBy,
        timeZone: q.timeZone,
        today: q.today,
      });
      if (t.rows.length > REPORT_MAX_ROWS)
        throw appError.unprocessable(
          ErrorCode.REPORT_TOO_LARGE,
          'Too many rows for one report: narrow the period or group it',
          { params: { max: REPORT_MAX_ROWS } },
        );
      return t;
    };
    const previous =
      q.compare === 'previous' || q.compare === 'both'
        ? previousPeriod(q.period)
        : null;
    const lastYear =
      q.compare === 'last_year' || q.compare === 'both'
        ? lastYearPeriod(q.period)
        : null;
    const lined = lineUp(
      columns,
      dimensions,
      await one(q.period),
      previous ? await one(previous) : null,
      lastYear ? await one(lastYear) : null,
    );
    return {
      key: def.key,
      title: def.title,
      groupBy,
      compare: q.compare,
      period: q.period,
      previousPeriod: previous,
      lastYearPeriod: lastYear,
      columns,
      dimensions,
      ...lined,
    };
  }

  /** The compound's name, as the PDF's heading says it. */
  async compoundName(
    tx: TenantTxClient,
    tenantId = this.ctx.txTenantId,
  ): Promise<string> {
    const t = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    return t.name;
  }

  /** A result as a file. Same result, same instant: same bytes. */
  async render(
    r: ReportResult,
    format: ReportFormat,
    compound: string,
    at: Date,
  ): Promise<ReportFile> {
    const sheet = flatten(r);
    const name = `${r.key.replace(/_/g, '-')}-${r.period.from}-${r.period.to}.${format}`;
    const contentType = TYPES[format];
    switch (format) {
      case 'csv':
        return {
          name,
          contentType,
          body: toCsv(
            sheet.headers.map((h, i) => ({
              header: h.en,
              kind: sheet.kinds[i],
            })),
            sheet.rows,
          ),
        };
      case 'xlsx':
        return {
          name,
          contentType,
          body: toXlsx(
            r.title.en,
            sheet.headers.map((h) => h.en),
            sheet.kinds,
            sheet.rows,
          ),
        };
      case 'pdf': {
        const lines = [
          `${r.period.from} to ${r.period.to} · grouped by ${r.groupBy.replace(/_/g, ' ')}`,
          ...(r.previousPeriod
            ? [
                `Compared with ${r.previousPeriod.from} to ${r.previousPeriod.to}`,
              ]
            : []),
          ...(r.lastYearPeriod
            ? [
                `Compared with ${r.lastYearPeriod.from} to ${r.lastYearPeriod.to}`,
              ]
            : []),
          `Drawn ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        ];
        const body = await this.pdf.render(
          {
            title: r.title.en,
            createdAt: at,
            layout: reportLayout(sheet.headers.length),
          },
          (page) =>
            drawReportTable(page, {
              compound,
              titleEn: r.title.en,
              titleAr: r.title.ar,
              lines,
              headers: sheet.headers,
              kinds: sheet.kinds,
              rows: sheet.rows,
              totalsLast: true,
            }),
        );
        return { name, contentType, body };
      }
    }
  }
}
