import { Injectable } from '@nestjs/common';
import { toCsv, type CsvColumn } from '../../core/common/csv';
import { REASON_CODES } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { RosterCore } from '../roster/roster-core';
import { CURRENCY } from '../violations/violations.service';
import type {
  IncidentReportCountsView,
  IncidentReportView,
  ViolationReportCountsView,
  ViolationReportView,
} from './views/security-reports.views';

type Period = { from?: string; to?: string };

const INCIDENT_COUNTS = [
  'reported',
  'byGuards',
  'low',
  'medium',
  'high',
  'critical',
  'open',
  'investigating',
  'closed',
] as const;

const INCIDENT_COLUMNS: CsvColumn[] = [
  { header: 'type', kind: 'text' },
  { header: 'reported', kind: 'number' },
  { header: 'by_guards', kind: 'number' },
  { header: 'low', kind: 'number' },
  { header: 'medium', kind: 'number' },
  { header: 'high', kind: 'number' },
  { header: 'critical', kind: 'number' },
  { header: 'open', kind: 'number' },
  { header: 'investigating', kind: 'number' },
  { header: 'closed', kind: 'number' },
  { header: 'avg_hours_to_close', kind: 'number' },
];

const VIOLATION_COUNTS = [
  'issued',
  'byGuards',
  'warnings',
  'fined',
  'amountIssued',
  'open',
  'underAppeal',
  'paid',
  'cancelled',
  'amountPaid',
  'appealed',
  'appealsUpheld',
  'appealsAccepted',
] as const;

const VIOLATION_COLUMNS: CsvColumn[] = [
  { header: 'kind', kind: 'text' },
  { header: 'issued', kind: 'number' },
  { header: 'by_guards', kind: 'number' },
  { header: 'warnings', kind: 'number' },
  { header: 'fined', kind: 'number' },
  { header: 'amount_issued', kind: 'number' },
  { header: 'open', kind: 'number' },
  { header: 'under_appeal', kind: 'number' },
  { header: 'paid', kind: 'number' },
  { header: 'cancelled', kind: 'number' },
  { header: 'amount_paid', kind: 'number' },
  { header: 'appealed', kind: 'number' },
  { header: 'appeals_upheld', kind: 'number' },
  { header: 'appeals_accepted', kind: 'number' },
  { header: 'currency', kind: 'text' },
];

/** The CSVs' last row: the period's totals. */
const ALL = 'all';

const noIncidents = (): IncidentReportCountsView => ({
  reported: 0,
  byGuards: 0,
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
  open: 0,
  investigating: 0,
  closed: 0,
  avgHoursToClose: null,
});

const noViolations = (): ViolationReportCountsView => ({
  issued: 0,
  byGuards: 0,
  warnings: 0,
  fined: 0,
  amountIssued: '0.00',
  open: 0,
  underAppeal: 0,
  paid: 0,
  cancelled: 0,
  amountPaid: '0.00',
  appealed: 0,
  appealsUpheld: 0,
  appealsAccepted: 0,
});

/**
 * The incidents and violations reports (ADR 0053), over the compound's
 * days asked (a week by default, 31 at most): counts only, every type or
 * kind in a fixed order and the period's totals, never a name, a note or
 * a unit. Incidents by when they happened, with their state now;
 * violations by their day. One fixed aggregate query each (a rollup gives
 * the totals); the CSVs are the same rows, the totals last.
 */
@Injectable()
export class SecurityReportsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly roster: RosterCore,
  ) {}

  incidents(q: Period): Promise<IncidentReportView> {
    return this.tenantTx.withTenantTx((tx) => this.incidentReport(tx, q));
  }

  violations(q: Period): Promise<ViolationReportView> {
    return this.tenantTx.withTenantTx((tx) => this.violationReport(tx, q));
  }

  async incidentsCsv(q: Period): Promise<{ name: string; body: Buffer }> {
    const r = await this.incidents(q);
    const row = (label: string, c: IncidentReportCountsView) => [
      label,
      ...INCIDENT_COUNTS.map((k) => String(c[k])),
      c.avgHoursToClose === null ? null : String(c.avgHoursToClose),
    ];
    return {
      name: `security-incidents-${r.from}-${r.to}.csv`,
      body: toCsv(INCIDENT_COLUMNS, [
        ...r.types.map((t) => row(t.type, t)),
        row(ALL, r.totals),
      ]),
    };
  }

  async violationsCsv(q: Period): Promise<{ name: string; body: Buffer }> {
    const r = await this.violations(q);
    const row = (label: string, c: ViolationReportCountsView) => [
      label,
      ...VIOLATION_COUNTS.map((k) => String(c[k])),
      r.currency,
    ];
    return {
      name: `security-violations-${r.from}-${r.to}.csv`,
      body: toCsv(VIOLATION_COLUMNS, [
        ...r.kinds.map((k) => row(k.kind, k)),
        row(ALL, r.totals),
      ]),
    };
  }

  private async incidentReport(
    tx: TenantTxClient,
    q: Period,
  ): Promise<IncidentReportView> {
    const period = await this.roster.period(tx, q, { back: 6, span: 6 });
    const rows = await tx.$queryRaw<
      {
        type: string | null;
        total: number;
        reported: number;
        by_guards: number;
        low: number;
        medium: number;
        high: number;
        critical: number;
        open: number;
        investigating: number;
        closed: number;
        avg_hours: number | null;
      }[]
    >`
      SELECT type, GROUPING(type)::int AS total,
             count(*)::int AS reported,
             count(*) FILTER (WHERE shift_id IS NOT NULL)::int AS by_guards,
             count(*) FILTER (WHERE severity = 'low')::int AS low,
             count(*) FILTER (WHERE severity = 'medium')::int AS medium,
             count(*) FILTER (WHERE severity = 'high')::int AS high,
             count(*) FILTER (WHERE severity = 'critical')::int AS critical,
             count(*) FILTER (WHERE status = 'open')::int AS open,
             count(*) FILTER (WHERE status = 'investigating')::int AS investigating,
             count(*) FILTER (WHERE status = 'closed')::int AS closed,
             round(avg(extract(epoch FROM closed_at - created_at) / 3600)
                   FILTER (WHERE status = 'closed'), 1)::float8 AS avg_hours
        FROM incidents
       WHERE occurred_at >= ${period.start} AND occurred_at < ${period.end}
       GROUP BY ROLLUP (type)`;
    const counts = (r: (typeof rows)[number]): IncidentReportCountsView => ({
      reported: r.reported,
      byGuards: r.by_guards,
      low: r.low,
      medium: r.medium,
      high: r.high,
      critical: r.critical,
      open: r.open,
      investigating: r.investigating,
      closed: r.closed,
      avgHoursToClose: r.avg_hours,
    });
    const total = rows.find((r) => r.total === 1);
    const byType = new Map(
      rows.filter((r) => r.total === 0).map((r) => [r.type!, counts(r)]),
    );
    return {
      from: period.from,
      to: period.to,
      totals: total ? counts(total) : noIncidents(),
      types: REASON_CODES.incidentType.map((type) => ({
        type,
        ...(byType.get(type) ?? noIncidents()),
      })),
    };
  }

  private async violationReport(
    tx: TenantTxClient,
    q: Period,
  ): Promise<ViolationReportView> {
    const period = await this.roster.period(tx, q, { back: 6, span: 6 });
    const rows = await tx.$queryRaw<
      {
        kind: string | null;
        total: number;
        issued: number;
        by_guards: number;
        warnings: number;
        fined: number;
        amount_issued: string;
        open: number;
        under_appeal: number;
        paid: number;
        cancelled: number;
        amount_paid: string;
        appealed: number;
        upheld: number;
        accepted: number;
      }[]
    >`
      SELECT kind, GROUPING(kind)::int AS total,
             count(*)::int AS issued,
             count(*) FILTER (WHERE issued_shift_id IS NOT NULL)::int AS by_guards,
             count(*) FILTER (WHERE amount IS NULL)::int AS warnings,
             count(*) FILTER (WHERE amount IS NOT NULL)::int AS fined,
             coalesce(sum(amount), 0)::numeric(12, 2)::text AS amount_issued,
             count(*) FILTER (WHERE status = 'open')::int AS open,
             count(*) FILTER (WHERE status = 'under_appeal')::int AS under_appeal,
             count(*) FILTER (WHERE status = 'paid')::int AS paid,
             count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
             coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0)::numeric(12, 2)::text
               AS amount_paid,
             count(*) FILTER (WHERE appealed_at IS NOT NULL)::int AS appealed,
             count(*) FILTER (WHERE appeal_decision = 'upheld')::int AS upheld,
             count(*) FILTER (WHERE appeal_decision = 'cancelled')::int AS accepted
        FROM unit_violations
       WHERE occurred_on >= ${period.from}::date AND occurred_on <= ${period.to}::date
       GROUP BY ROLLUP (kind)`;
    const counts = (r: (typeof rows)[number]): ViolationReportCountsView => ({
      issued: r.issued,
      byGuards: r.by_guards,
      warnings: r.warnings,
      fined: r.fined,
      amountIssued: r.amount_issued,
      open: r.open,
      underAppeal: r.under_appeal,
      paid: r.paid,
      cancelled: r.cancelled,
      amountPaid: r.amount_paid,
      appealed: r.appealed,
      appealsUpheld: r.upheld,
      appealsAccepted: r.accepted,
    });
    const total = rows.find((r) => r.total === 1);
    const byKind = new Map(
      rows.filter((r) => r.total === 0).map((r) => [r.kind!, counts(r)]),
    );
    return {
      from: period.from,
      to: period.to,
      currency: CURRENCY,
      totals: total ? counts(total) : noViolations(),
      kinds: REASON_CODES.violationKind.map((kind) => ({
        kind,
        ...(byKind.get(kind) ?? noViolations()),
      })),
    };
  }
}
