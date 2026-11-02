import { Injectable } from '@nestjs/common';
import { toCsv, type CsvColumn } from '../../core/common/csv';
import { REASON_CODES } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { localDate } from '../../core/common/slots/day-slots';
import { MaintenanceGatePort } from '../../maintenance';
import { dbNow } from '../db-clock';
import { RosterCore } from '../roster/roster-core';
import { CURRENCY } from '../violations/violations.service';
import type {
  IncidentReportCountsView,
  IncidentReportView,
  SafetyReportView,
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
/** The incidents report and the safety KPIs cover up to a year (ADR 0087). */
export const SAFETY_MAX_DAYS = 366;
/** The incident types the safety KPIs count. */
const SAFETY_TYPES = [
  'injury',
  'near_miss',
  'hazard',
  'fire',
  'property_damage',
];
/** A safety observation: a hazard or a near miss someone reported. */
const OBSERVATIONS = ['hazard', 'near_miss'];

const pct = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.floor((part * 100) / whole);

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
 * days asked (a week by default, 31 at most; incidents 366, ADR 0087):
 * counts only, every type or
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
    private readonly maintenance: MaintenanceGatePort,
  ) {}

  /**
   * The safety KPIs (ADR 0087) over the compound's days asked (30 by
   * default, 366 at most): the safety incidents by type and the last
   * injury, the observations' closure rate and time, the corrective
   * actions made then and where all stand now, and the drills. Each an
   * aggregate in SQL, counts and rates only.
   */
  safety(q: Period): Promise<SafetyReportView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const period = await this.roster.period(
        tx,
        q,
        { back: 29, span: 29 },
        SAFETY_MAX_DAYS,
      );
      const tz = await this.roster.timeZone(tx);
      const today = localDate(await dbNow(tx), tz);
      const [i] = await tx.$queryRaw<
        {
          reported: number;
          injuries: number;
          near_misses: number;
          hazards: number;
          fires: number;
          property_damage: number;
          observations: number;
          observations_closed: number;
          avg_hours: number | null;
        }[]
      >`
        SELECT count(*) FILTER (WHERE type = ANY(${SAFETY_TYPES}::text[]))::int AS reported,
               count(*) FILTER (WHERE type = 'injury')::int AS injuries,
               count(*) FILTER (WHERE type = 'near_miss')::int AS near_misses,
               count(*) FILTER (WHERE type = 'hazard')::int AS hazards,
               count(*) FILTER (WHERE type = 'fire')::int AS fires,
               count(*) FILTER (WHERE type = 'property_damage')::int AS property_damage,
               count(*) FILTER (WHERE type = ANY(${OBSERVATIONS}::text[]))::int AS observations,
               count(*) FILTER (WHERE type = ANY(${OBSERVATIONS}::text[])
                                  AND status = 'closed')::int AS observations_closed,
               round(avg(extract(epoch FROM closed_at - created_at) / 3600)
                     FILTER (WHERE type = ANY(${OBSERVATIONS}::text[])
                               AND status = 'closed'), 1)::float8 AS avg_hours
          FROM incidents
         WHERE occurred_at >= ${period.start} AND occurred_at < ${period.end}`;
      const [last] = await tx.$queryRaw<{ day: string | null }[]>`
        SELECT to_char(max(occurred_at) AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day
          FROM incidents
         WHERE type = 'injury' AND occurred_at < ${period.end}`;
      const [a] = await tx.$queryRaw<
        {
          opened: number;
          done: number;
          done_on_time: number;
          cancelled: number;
          open_now: number;
          overdue_now: number;
        }[]
      >`
        SELECT count(*) FILTER (WHERE created_at >= ${period.start}
                                  AND created_at < ${period.end})::int AS opened,
               count(*) FILTER (WHERE created_at >= ${period.start} AND created_at < ${period.end}
                                  AND status = 'done')::int AS done,
               count(*) FILTER (WHERE created_at >= ${period.start} AND created_at < ${period.end}
                                  AND status = 'done'
                                  AND (done_at AT TIME ZONE ${tz})::date <= due_on)::int AS done_on_time,
               count(*) FILTER (WHERE created_at >= ${period.start} AND created_at < ${period.end}
                                  AND status = 'cancelled')::int AS cancelled,
               count(*) FILTER (WHERE status = 'open')::int AS open_now,
               count(*) FILTER (WHERE status = 'open'
                                  AND due_on < ${today}::date)::int AS overdue_now
          FROM incident_actions`;
      const lastInjuryOn = last?.day ?? null;
      return {
        from: period.from,
        to: period.to,
        incidents: {
          reported: i?.reported ?? 0,
          injuries: i?.injuries ?? 0,
          nearMisses: i?.near_misses ?? 0,
          hazards: i?.hazards ?? 0,
          fires: i?.fires ?? 0,
          propertyDamage: i?.property_damage ?? 0,
          lastInjuryOn,
          daysWithoutInjury: lastInjuryOn
            ? Math.max(
                0,
                Math.round(
                  (Date.parse(`${period.to}T00:00:00Z`) -
                    Date.parse(`${lastInjuryOn}T00:00:00Z`)) /
                    86_400_000,
                ),
              )
            : null,
        },
        observations: {
          reported: i?.observations ?? 0,
          closed: i?.observations_closed ?? 0,
          closureRatePct: pct(
            i?.observations_closed ?? 0,
            i?.observations ?? 0,
          ),
          avgHoursToClose: i?.avg_hours ?? null,
        },
        actions: {
          opened: a?.opened ?? 0,
          done: a?.done ?? 0,
          doneOnTime: a?.done_on_time ?? 0,
          cancelled: a?.cancelled ?? 0,
          onTimeRatePct: pct(a?.done_on_time ?? 0, a?.done ?? 0),
          openNow: a?.open_now ?? 0,
          overdueNow: a?.overdue_now ?? 0,
        },
        drills: await this.maintenance.drills(tx, period),
      };
    });
  }

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
    // ADR 0087: a year at most, as the safety KPIs.
    const period = await this.roster.period(
      tx,
      q,
      { back: 6, span: 6 },
      SAFETY_MAX_DAYS,
    );
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
