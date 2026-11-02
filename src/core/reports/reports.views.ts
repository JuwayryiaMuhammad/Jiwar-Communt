import { ApiProperty } from '@nestjs/swagger';
import type { ReportRun, ReportSchedule } from '@prisma/client';
import type { PresignedRead } from '../files/object-storage';
import type { CompoundExportRead } from './compound-exports.service';
import type { ReportResult, ReportRow } from './report-compare';
import {
  REPORT_CADENCES,
  REPORT_COMPARISONS,
  REPORT_FORMATS,
} from './report-periods';
import { REPORT_KEYS, type ReportPeriod } from './report-registry';
import type { ReportCatalogEntry } from './reports.service';

const day = (d: Date) => d.toISOString().slice(0, 10);

export class ReportTitleView {
  @ApiProperty({ type: String })
  en: string;
  @ApiProperty({ type: String })
  ar: string;
}

export class ReportCatalogView {
  @ApiProperty({ enum: REPORT_KEYS, enumName: 'ReportKey' })
  key: string;
  @ApiProperty({ type: ReportTitleView })
  title: ReportTitleView;
  @ApiProperty({ type: String, description: 'What reads it.' })
  permission: string;
  @ApiProperty({
    type: [String],
    description: 'Its groupings, the default first.',
  })
  groupBy: string[];

  static from(r: ReportCatalogEntry): ReportCatalogView {
    return {
      key: r.key,
      title: r.title,
      permission: r.permission,
      groupBy: [...r.groupBy],
    };
  }
}

export class ReportPeriodView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: Number })
  days: number;

  static from(p: ReportPeriod): ReportPeriodView {
    return { from: p.from, to: p.to, days: p.days };
  }
}

export class ReportColumnView {
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String })
  en: string;
  @ApiProperty({ type: String })
  ar: string;
  @ApiProperty({ enum: ['text', 'number', 'money'] })
  kind: string;
  @ApiProperty({
    type: Boolean,
    description: 'Summed in the totals; 0 where a period has no row.',
  })
  sum: boolean;
}

const CELLS = {
  type: 'array',
  items: { type: 'string', nullable: true },
} as const;

export class ReportRowView {
  @ApiProperty({
    ...CELLS,
    description: 'The cells, in column order: figures as decimal strings.',
  })
  values: (string | null)[];
  @ApiProperty({ ...CELLS, nullable: true })
  previous: (string | null)[] | null;
  @ApiProperty({ ...CELLS, nullable: true })
  lastYear: (string | null)[] | null;

  static from(r: ReportRow): ReportRowView {
    return { values: r.values, previous: r.previous, lastYear: r.lastYear };
  }
}

export class ReportView {
  @ApiProperty({ enum: REPORT_KEYS, enumName: 'ReportKey' })
  key: string;
  @ApiProperty({ type: ReportTitleView })
  title: ReportTitleView;
  @ApiProperty({ type: String })
  groupBy: string;
  @ApiProperty({ enum: REPORT_COMPARISONS, enumName: 'ReportComparison' })
  compare: string;
  @ApiProperty({ type: ReportPeriodView })
  period: ReportPeriodView;
  @ApiProperty({ type: ReportPeriodView, nullable: true })
  previousPeriod: ReportPeriodView | null;
  @ApiProperty({ type: ReportPeriodView, nullable: true })
  lastYearPeriod: ReportPeriodView | null;
  @ApiProperty({ type: [ReportColumnView] })
  columns: ReportColumnView[];
  @ApiProperty({
    type: Number,
    description: 'The leading columns that name a row.',
  })
  dimensions: number;
  @ApiProperty({ type: [ReportRowView] })
  rows: ReportRowView[];
  @ApiProperty({ type: ReportRowView })
  totals: ReportRowView;

  static from(r: ReportResult): ReportView {
    return {
      key: r.key,
      title: r.title,
      groupBy: r.groupBy,
      compare: r.compare,
      period: ReportPeriodView.from(r.period),
      previousPeriod: r.previousPeriod
        ? ReportPeriodView.from(r.previousPeriod)
        : null,
      lastYearPeriod: r.lastYearPeriod
        ? ReportPeriodView.from(r.lastYearPeriod)
        : null,
      columns: r.columns.map((c) => ({
        key: c.key,
        en: c.en,
        ar: c.ar,
        kind: c.kind,
        sum: !!c.sum,
      })),
      dimensions: r.dimensions,
      rows: r.rows.map(ReportRowView.from),
      totals: ReportRowView.from(r.totals),
    };
  }
}

export class ReportScheduleView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: REPORT_KEYS, enumName: 'ReportKey' })
  reportKey: string;
  @ApiProperty({ enum: REPORT_CADENCES, enumName: 'ReportCadence' })
  cadence: string;
  @ApiProperty({ enum: REPORT_FORMATS, enumName: 'ReportFormat' })
  format: string;
  @ApiProperty({ enum: REPORT_COMPARISONS, enumName: 'ReportComparison' })
  compare: string;
  @ApiProperty({ type: String, nullable: true })
  groupBy: string | null;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(s: ReportSchedule): ReportScheduleView {
    return {
      id: s.id,
      reportKey: s.reportKey,
      cadence: s.cadence,
      format: s.format,
      compare: s.compare,
      groupBy: s.groupBy,
      active: s.active,
      createdAt: s.createdAt,
    };
  }
}

export class ReportRunView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  scheduleId: string;
  @ApiProperty({ enum: REPORT_KEYS, enumName: 'ReportKey' })
  reportKey: string;
  @ApiProperty({ type: String, format: 'date' })
  periodFrom: string;
  @ApiProperty({ type: String, format: 'date' })
  periodTo: string;
  @ApiProperty({ enum: REPORT_FORMATS, enumName: 'ReportFormat' })
  format: string;
  @ApiProperty({ type: Number })
  rows: number;
  @ApiProperty({ enum: ['ready', 'expired'] })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  writtenAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(r: ReportRun): ReportRunView {
    return {
      id: r.id,
      scheduleId: r.scheduleId,
      reportKey: r.reportKey,
      periodFrom: day(r.periodFrom),
      periodTo: day(r.periodTo),
      format: r.format,
      rows: r.rows,
      status: r.status,
      writtenAt: r.writtenAt,
      expiresAt: r.expiresAt,
    };
  }
}

export class CompoundExportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ['pending', 'building', 'ready', 'expired', 'failed'] })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readyAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Its tables.' })
  tables: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Its rows.' })
  rows: number | null;

  static from(r: CompoundExportRead): CompoundExportView {
    return { ...r };
  }
}

export class FileLinkView {
  @ApiProperty({
    type: String,
    description: 'A presigned GET of the file, valid a few minutes.',
  })
  url: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(r: PresignedRead): FileLinkView {
    return { url: r.url, expiresAt: r.expiresAt };
  }
}
