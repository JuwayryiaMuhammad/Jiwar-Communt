import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toCsv, type CsvColumn } from '../../core/common/csv';
import { addDays } from '../../core/common/slots/day-slots';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RosterCore } from '../roster/roster-core';
import { SERVICE_VEHICLE_KINDS } from '../service-vehicles/service-vehicle-rules';

/** Visitors by how they came in. */
export interface TrafficVisitors {
  visitorPass: number;
  gateRequest: number;
  fieldException: number;
}

export type TrafficServiceVehicles = Record<
  (typeof SERVICE_VEHICLE_KINDS)[number],
  number
>;

export interface TrafficCounts {
  visitors: TrafficVisitors;
  serviceVehicles: TrafficServiceVehicles;
  residentVehicles: { in: number; out: number };
}

export interface TrafficRow extends TrafficCounts {
  date: string;
  gate: { id: string; name: string };
}

export interface TrafficReport {
  from: string;
  to: string;
  rows: TrafficRow[];
  totals: TrafficCounts;
}

/** The CSV's columns, one row per day and gate, the totals last. */
export const TRAFFIC_COLUMNS: readonly CsvColumn[] = [
  { header: 'date', kind: 'text' },
  { header: 'gate', kind: 'text' },
  { header: 'visitors_pass', kind: 'number' },
  { header: 'visitors_gate_request', kind: 'number' },
  { header: 'visitors_field_exception', kind: 'number' },
  { header: 'service_tanker', kind: 'number' },
  { header: 'service_waste', kind: 'number' },
  { header: 'service_delivery', kind: 'number' },
  { header: 'service_other', kind: 'number' },
  { header: 'resident_vehicles_in', kind: 'number' },
  { header: 'resident_vehicles_out', kind: 'number' },
];

const zero = (): TrafficCounts => ({
  visitors: { visitorPass: 0, gateRequest: 0, fieldException: 0 },
  serviceVehicles: { tanker: 0, waste: 0, delivery: 0, other: 0 },
  residentVehicles: { in: 0, out: 0 },
});

function add(into: TrafficCounts, c: TrafficCounts): void {
  for (const k of Object.keys(into.visitors) as (keyof TrafficVisitors)[])
    into.visitors[k] += c.visitors[k];
  for (const k of SERVICE_VEHICLE_KINDS)
    into.serviceVehicles[k] += c.serviceVehicles[k];
  into.residentVehicles.in += c.residentVehicles.in;
  into.residentVehicles.out += c.residentVehicles.out;
}

/**
 * The traffic report (ADR 0056), for the management (`gate.read`): per
 * compound day and gate, the visitors who came in (by pass, gate request
 * or field exception), the service vehicles that came in (by kind) and the
 * resident vehicles counted in and out. Counts only: never a name, a unit
 * or a plate. The compound's days `from`…`to`: the last seven by default,
 * 31 at most. Every active gate has its row for every day, and any gate
 * with traffic in the period too.
 */
@Injectable()
export class TrafficReportService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly roster: RosterCore,
  ) {}

  report(q: {
    from?: string;
    to?: string;
    gateId?: string;
  }): Promise<TrafficReport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const period = await this.roster.period(tx, q, { back: 6, span: 6 });
      const tz = await this.roster.timeZone(tx);
      const onlyGate = (column: Prisma.Sql) =>
        q.gateId ? Prisma.sql`AND ${column} = ${q.gateId}::uuid` : Prisma.empty;
      const counts = new Map<string, TrafficCounts>();
      const of = (date: string, gateId: string) => {
        const key = `${date}|${gateId}`;
        let c = counts.get(key);
        if (!c) counts.set(key, (c = zero()));
        return c;
      };
      const visitors = await tx.$queryRaw<
        { day: string; gate_id: string; subject_type: string; n: number }[]
      >`
        SELECT to_char((occurred_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day,
               gate_id, subject_type::text AS subject_type, count(*)::int AS n
          FROM gate_entries
         WHERE direction = 'in'
           AND subject_type IN ('visitor_pass', 'gate_request', 'field_exception')
           AND occurred_at >= ${period.start} AND occurred_at < ${period.end}
           ${onlyGate(Prisma.sql`gate_id`)}
         GROUP BY 1, 2, 3`;
      for (const r of visitors) {
        const c = of(r.day, r.gate_id);
        if (r.subject_type === 'visitor_pass') c.visitors.visitorPass += r.n;
        else if (r.subject_type === 'gate_request')
          c.visitors.gateRequest += r.n;
        else c.visitors.fieldException += r.n;
      }
      const service = await tx.$queryRaw<
        { day: string; gate_id: string; kind: string; n: number }[]
      >`
        SELECT to_char((entered_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day,
               entered_gate_id AS gate_id, kind, count(*)::int AS n
          FROM service_vehicle_visits
         WHERE entered_at >= ${period.start} AND entered_at < ${period.end}
           ${onlyGate(Prisma.sql`entered_gate_id`)}
         GROUP BY 1, 2, 3`;
      for (const r of service) {
        const c = of(r.day, r.gate_id);
        c.serviceVehicles[r.kind as keyof TrafficServiceVehicles] += r.n;
      }
      const residents = await tx.$queryRaw<
        { day: string; gate_id: string; direction: 'in' | 'out'; n: number }[]
      >`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, gate_id,
               direction::text AS direction, count::int AS n
          FROM gate_vehicle_counts
         WHERE day >= ${period.from}::date AND day <= ${period.to}::date
           ${onlyGate(Prisma.sql`gate_id`)}`;
      for (const r of residents)
        of(r.day, r.gate_id).residentVehicles[r.direction] += r.n;
      // Every active gate (the one asked for, if any), and any with traffic.
      const traffic = new Set([...counts.keys()].map((k) => k.split('|')[1]));
      const gates = await tx.gate.findMany({
        where: q.gateId
          ? { id: q.gateId }
          : { OR: [{ status: 'active' }, { id: { in: [...traffic] } }] },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      const rows: TrafficRow[] = [];
      const totals = zero();
      for (let d = period.from; d <= period.to; d = addDays(d, 1))
        for (const gate of gates) {
          const c = counts.get(`${d}|${gate.id}`) ?? zero();
          add(totals, c);
          rows.push({ date: d, gate, ...c });
        }
      return { from: period.from, to: period.to, rows, totals };
    });
  }

  /** The same, as CSV: a byte-order mark, CRLF, the totals last. */
  async csv(q: {
    from?: string;
    to?: string;
    gateId?: string;
  }): Promise<{ name: string; body: Buffer }> {
    const r = await this.report(q);
    const line = (date: string, gate: string, c: TrafficCounts) => [
      date,
      gate,
      String(c.visitors.visitorPass),
      String(c.visitors.gateRequest),
      String(c.visitors.fieldException),
      ...SERVICE_VEHICLE_KINDS.map((k) => String(c.serviceVehicles[k])),
      String(c.residentVehicles.in),
      String(c.residentVehicles.out),
    ];
    return {
      name: `gate-traffic-${r.from}-${r.to}.csv`,
      body: toCsv(TRAFFIC_COLUMNS, [
        ...r.rows.map((row) => line(row.date, row.gate.name, row)),
        line('all', 'all', r.totals),
      ]),
    };
  }
}
