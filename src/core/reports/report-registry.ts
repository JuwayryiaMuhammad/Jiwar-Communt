import { Injectable } from '@nestjs/common';
import type { Permission } from '../access/permissions';
import type { LocalDate } from '../common/slots/day-slots';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// The reports platform (ADR 0086)
// ============================================================================
//
// Curated reports, read by the compound's staff on screen and as a PDF, a
// workbook or CSV, compared with another period, and sent on a cadence.
// Core imports no domain (ADR 0015): each domain registers its reports here
// at startup, as with the dashboard's sections (ADR 0079) and the inbox's
// types (ADR 0073), and reads them in the caller's tenant transaction (RLS)
// in a fixed number of aggregate SQL queries. A report shows to the holders
// of its own permission only. A report's rows are groups of the compound
// (a building, an asset type, an item, a category, a month), never a
// person, a unit or anybody's words.

/** The reports, in the order the catalog shows them. */
export const REPORT_KEYS = [
  'maintenance_spend',
  'stock_consumption',
  'service_by_building',
  'energy_cost',
  'collections_by_building',
  'cash_flow',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/**
 * The permissions the domains' reports are read by (ADR 0086): who may
 * open the catalog at all. ReportsService refuses at boot a report whose
 * permission is not one of these.
 */
export const REPORT_READERS = [
  'assets.manage',
  'stock.manage',
  'tickets.dispatch',
  'energy.read',
  'finance.reports',
  'finance.cashflow',
] as const satisfies readonly Permission[];

/** The longest period one report covers, as the domains' reports (ADR 0065). */
export const REPORT_PERIOD_MAX_DAYS = 366;
/** The most rows one report holds: more answers REPORT_TOO_LARGE. */
export const REPORT_MAX_ROWS = 5000;

/** A period of the compound's days, both ends included. */
export interface ReportPeriod {
  from: LocalDate;
  to: LocalDate;
  /** How many days it holds. */
  days: number;
}

/**
 * A column. A `text` one is a dimension (a building's name, a code) or a
 * note's code; a `number` or `money` one is a figure, as a decimal string.
 * `sum`: the total row adds it up, and a period without the row counts it
 * as 0 (a count, an amount); otherwise (a share, a rate) it stays null.
 */
export interface ReportColumn {
  key: string;
  en: string;
  ar: string;
  kind: 'text' | 'number' | 'money';
  sum?: true;
}

/** What a report reads: its rows, one array of cells a row, in column order. */
export interface ReportTable {
  rows: (string | null)[][];
}

export interface ReportRequest {
  period: ReportPeriod;
  /** One of the report's own groupings (its first by default). */
  groupBy: string;
  timeZone: string;
  /** The compound's today, by its clock. */
  today: LocalDate;
}

export interface ReportDefinition {
  key: ReportKey;
  /** The caller holds it, or the report is not theirs (403). */
  permission: Permission;
  title: { en: string; ar: string };
  /** The groupings it offers, its default first. */
  groupBy: readonly string[];
  /**
   * The columns for a grouping: the leading `dimensions` of them name the
   * row, so the rows of two periods match on them.
   */
  columns(groupBy: string): { columns: ReportColumn[]; dimensions: number };
  /**
   * The rows, in the caller's tenant transaction, at most
   * REPORT_MAX_ROWS + 1 of them (one more says it is too large).
   */
  read(tx: TenantTxClient, q: ReportRequest): Promise<ReportTable>;
}

@Injectable()
export class StaffReports {
  private readonly reports = new Map<ReportKey, ReportDefinition>();

  register(report: ReportDefinition): void {
    if (this.reports.has(report.key))
      throw new Error(`Report ${report.key} registered twice`);
    if (!report.groupBy.length)
      throw new Error(`Report ${report.key} offers no grouping`);
    this.reports.set(report.key, report);
  }

  get(key: string): ReportDefinition | null {
    return this.reports.get(key as ReportKey) ?? null;
  }

  /** In REPORT_KEYS order. */
  all(): ReportDefinition[] {
    return REPORT_KEYS.flatMap((k) => {
      const r = this.reports.get(k);
      return r ? [r] : [];
    });
  }

  /** The reports no domain registered (bootstrap). */
  missing(): ReportKey[] {
    return REPORT_KEYS.filter((k) => !this.reports.has(k));
  }
}
