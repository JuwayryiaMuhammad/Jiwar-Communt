import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  REPORT_MAX_ROWS,
  StaffReports,
  type ReportColumn,
  type ReportRequest,
} from '../../core/reports/report-registry';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { ConsumptionService } from '../energy/consumption.service';
import { SensitiveTickets } from '../tickets/sensitive-tickets';
import { METER_UNITS, type MeterKind } from '../energy/meter-rules';

// ============================================================================
// Maintenance's reports (ADR 0086)
// ============================================================================
//
// Registered with core's StaffReports: what maintenance cost by building,
// asset type, category or month (`assets.manage`, as asset economics, ADR
// 0065); the parts the work used, net of returns (`stock.manage`); the work
// each building asked for against its share of the units (`tickets.dispatch`);
// and what energy cost a square metre of each building (`energy.read`). Each
// is read in the caller's tenant transaction (RLS), aggregated in SQL;
// groups only, never a ticket, a unit or a word.

/** A ticket's building: its unit's, its area's, or its asset's place's. */
const TICKET_PLACE = Prisma.sql`
  LEFT JOIN units u ON u.id = k.unit_id
  LEFT JOIN common_areas ca ON ca.id = k.common_area_id
  LEFT JOIN assets a ON a.id = k.asset_id
  LEFT JOIN units au ON au.id = a.unit_id
  LEFT JOIN common_areas aca ON aca.id = a.common_area_id
  LEFT JOIN asset_types aty ON aty.id = a.type_id`;
const TICKET_BUILDING = Prisma.sql`COALESCE(u.building, ca.building, au.building, aca.building)`;

const LIMIT = REPORT_MAX_ROWS + 1;

const col = (
  key: string,
  en: string,
  ar: string,
  kind: ReportColumn['kind'],
  sum = false,
): ReportColumn => ({ key, en, ar, kind, ...(sum ? { sum: true } : {}) });

const DIMENSION: Record<string, ReportColumn> = {
  building: col('building', 'Building', 'المبنى', 'text'),
  asset_type: col('assetType', 'Asset type', 'نوع الأصل', 'text'),
  category: col('category', 'Category', 'الفئة', 'text'),
  month: col('month', 'Month', 'الشهر', 'text'),
};

/** The cells of a row, as text: Postgres casts each figure itself. */
type Cells = Record<string, string | null>;
const cells = (rows: Cells[], keys: readonly string[]) =>
  rows.map((r) => keys.map((k) => r[k] ?? null));

const inDays = (column: Prisma.Sql, q: ReportRequest) => Prisma.sql`
  (${column} AT TIME ZONE ${q.timeZone})::date
    BETWEEN ${q.period.from}::date AND ${q.period.to}::date`;

const SPEND_COLUMNS = [
  col('tickets', 'Tickets', 'البلاغات', 'number', true),
  col('labour', 'Labour', 'العمالة', 'money', true),
  col('contractor', 'Contractors', 'المقاولون', 'money', true),
  col('parts', 'Parts', 'قطع الغيار', 'money', true),
  col('other', 'Other', 'أخرى', 'money', true),
  col('total', 'Total', 'الإجمالي', 'money', true),
  col('share', 'Share of the total %', 'النسبة من الإجمالي %', 'number'),
];

const ENERGY_KINDS: readonly MeterKind[] = ['electricity', 'water', 'gas'];

@Injectable()
export class MaintenanceReports implements OnModuleInit {
  constructor(
    private readonly reports: StaffReports,
    private readonly consumption: ConsumptionService,
    private readonly sensitive: SensitiveTickets,
  ) {}

  /**
   * Every ticket a report counts or costs (alias `k`) goes through this one
   * condition (ADR 0081): a reader without `tickets.sensitive` counts none
   * of the sensitive ones, nor does a scheduled run (no reader: the system
   * writes it for every holder).
   */
  private async countable(): Promise<Prisma.Sql> {
    return (await this.sensitive.sql('k'))[0] ?? Prisma.sql`TRUE`;
  }

  onModuleInit(): void {
    this.reports.register({
      key: 'maintenance_spend',
      permission: 'assets.manage',
      title: {
        en: 'Maintenance spend',
        ar: 'الإنفاق على الصيانة',
      },
      groupBy: ['building', 'asset_type', 'category', 'month'],
      columns: (g) => ({
        columns: [DIMENSION[g], ...SPEND_COLUMNS],
        dimensions: 1,
      }),
      read: (tx, q) => this.spend(tx, q),
    });
    this.reports.register({
      key: 'stock_consumption',
      permission: 'stock.manage',
      title: { en: 'Stock consumption', ar: 'استهلاك المخزون' },
      groupBy: ['item', 'asset_type', 'month'],
      columns: (g) =>
        g === 'item'
          ? {
              columns: [
                col('sku', 'SKU', 'الرمز', 'text'),
                col('item', 'Item', 'الصنف', 'text'),
                col('unit', 'Unit', 'الوحدة', 'text'),
                col('issued', 'Issued', 'المنصرف', 'number', true),
                col('returned', 'Returned', 'المرتجع', 'number', true),
                col('net', 'Used', 'المستهلك', 'number', true),
                col('value', 'Value', 'القيمة', 'money', true),
                col(
                  'perMonth',
                  'Used a month',
                  'متوسط الاستهلاك الشهري',
                  'number',
                ),
              ],
              dimensions: 1,
            }
          : {
              // Quantities of different items do not add up: value only.
              columns: [
                DIMENSION[g],
                col('issues', 'Issues', 'مرات الصرف', 'number', true),
                col('returns', 'Returns', 'مرات الإرجاع', 'number', true),
                col('value', 'Value', 'القيمة', 'money', true),
              ],
              dimensions: 1,
            },
      read: (tx, q) => this.stock(tx, q),
    });
    this.reports.register({
      key: 'service_by_building',
      permission: 'tickets.dispatch',
      title: {
        en: 'Service by building',
        ar: 'الخدمة حسب المبنى',
      },
      groupBy: ['building'],
      columns: () => ({
        columns: [
          DIMENSION.building,
          col('units', 'Units', 'الوحدات', 'number', true),
          col('opened', 'Opened', 'المفتوحة', 'number', true),
          col('completed', 'Completed', 'المنجزة', 'number', true),
          col('emergencies', 'Emergencies', 'الطوارئ', 'number', true),
          col('mttrHours', 'Hours to complete', 'ساعات الإنجاز', 'number'),
          col('per10Units', 'Opened per 10 units', 'لكل 10 وحدات', 'number'),
          col('ticketShare', 'Share of tickets %', 'نسبة البلاغات %', 'number'),
          col('unitShare', 'Share of units %', 'نسبة الوحدات %', 'number'),
        ],
        dimensions: 1,
      }),
      read: (tx, q) => this.service(tx, q),
    });
    this.reports.register({
      key: 'energy_cost',
      permission: 'energy.read',
      title: {
        en: 'Energy cost per square metre',
        ar: 'تكلفة الطاقة لكل متر مربع',
      },
      groupBy: ['building'],
      columns: () => ({
        columns: [
          DIMENSION.building,
          col('kind', 'Kind', 'النوع', 'text'),
          col('use', 'Use', 'الاستهلاك', 'number'),
          col('unit', 'Unit', 'الوحدة', 'text'),
          col('cost', 'Cost', 'التكلفة', 'money', true),
          col('areaSqm', 'Floor area m²', 'المساحة م²', 'number'),
          col(
            'unitsWithoutArea',
            'Units with no area',
            'وحدات بلا مساحة',
            'number',
          ),
          col('costPerSqm', 'Cost per m²', 'التكلفة لكل م²', 'money'),
          col('note', 'Why not', 'السبب', 'text'),
        ],
        dimensions: 2,
      }),
      read: (tx, q) => this.energy(tx, q),
    });
  }

  /** Cost entries (voided ones aside) entered on the period's days, grouped. */
  private async spend(tx: TenantTxClient, q: ReportRequest) {
    const countable = await this.countable();
    const groups: Record<string, Prisma.Sql> = {
      building: TICKET_BUILDING,
      asset_type: Prisma.sql`aty.key`,
      category: Prisma.sql`c.key`,
      month: Prisma.sql`to_char(e.entered_at AT TIME ZONE ${q.timeZone}, 'YYYY-MM')`,
    };
    const g = groups[q.groupBy];
    const rows = await tx.$queryRaw<Cells[]>`
      WITH s AS (
        SELECT ${g} AS grp,
               count(DISTINCT k.id) AS tickets,
               COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'labour'), 0) AS labour,
               COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'contractor'), 0) AS contractor,
               COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'part'), 0) AS parts,
               COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'other'), 0) AS other,
               COALESCE(SUM(e.amount), 0) AS total
          FROM ticket_cost_entries e
          JOIN tickets k ON k.id = e.ticket_id
          JOIN ticket_categories c ON c.id = k.category_id
          ${TICKET_PLACE}
         WHERE e.voided_at IS NULL AND ${countable}
           AND ${inDays(Prisma.sql`e.entered_at`, q)}
         GROUP BY 1
      )
      SELECT grp, tickets::text, labour::text, contractor::text, parts::text,
             other::text, total::text,
             CASE WHEN SUM(total) OVER () > 0
                  THEN round(total * 100 / SUM(total) OVER (), 1)::text END AS share
        FROM s
       ORDER BY total DESC, grp NULLS LAST
       LIMIT ${LIMIT}`;
    return {
      rows: cells(rows, [
        'grp',
        'tickets',
        'labour',
        'contractor',
        'parts',
        'other',
        'total',
        'share',
      ]),
    };
  }

  /**
   * Issues and returns of the period's days (ADR 0065), net: a part issued
   * to a ticket and brought back counts once; its value is the cost entries
   * the movements wrote (an issue's at the average cost then, a return's
   * negative).
   */
  private async stock(tx: TenantTxClient, q: ReportRequest) {
    const countable = await this.countable();
    const base = Prisma.sql`
      FROM stock_movements m
      JOIN stock_items i ON i.id = m.item_id
      LEFT JOIN ticket_cost_entries e ON e.movement_id = m.id AND e.voided_at IS NULL
      LEFT JOIN tickets k ON k.id = m.ticket_id
      LEFT JOIN assets a ON a.id = k.asset_id
      LEFT JOIN asset_types aty ON aty.id = a.type_id
     WHERE m.kind IN ('issue', 'return')
       AND (k.id IS NULL OR ${countable})
       AND ${inDays(Prisma.sql`m.occurred_at`, q)}`;
    if (q.groupBy === 'item') {
      const rows = await tx.$queryRaw<Cells[]>`
        SELECT i.sku, i.name_en AS item, i.unit,
               (-COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'issue'), 0))::text AS issued,
               COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'return'), 0)::text AS returned,
               (-SUM(m.quantity))::text AS net,
               COALESCE(SUM(e.amount), 0)::text AS value,
               round(-SUM(m.quantity) * 30 / ${q.period.days}::int, 3)::text AS per_month
          ${base}
         GROUP BY i.id, i.sku, i.name_en, i.unit
         ORDER BY COALESCE(SUM(e.amount), 0) DESC, i.sku
         LIMIT ${LIMIT}`;
      return {
        rows: cells(rows, [
          'sku',
          'item',
          'unit',
          'issued',
          'returned',
          'net',
          'value',
          'per_month',
        ]),
      };
    }
    const g =
      q.groupBy === 'asset_type'
        ? Prisma.sql`aty.key`
        : Prisma.sql`to_char(m.occurred_at AT TIME ZONE ${q.timeZone}, 'YYYY-MM')`;
    const rows = await tx.$queryRaw<Cells[]>`
      SELECT ${g} AS grp,
             count(*) FILTER (WHERE m.kind = 'issue')::text AS issues,
             count(*) FILTER (WHERE m.kind = 'return')::text AS returns,
             COALESCE(SUM(e.amount), 0)::text AS value
        ${base}
       GROUP BY 1
       ORDER BY COALESCE(SUM(e.amount), 0) DESC, 1 NULLS LAST
       LIMIT ${LIMIT}`;
    return { rows: cells(rows, ['grp', 'issues', 'returns', 'value']) };
  }

  /**
   * Per building (ADR 0072's names): its units, the tickets opened and
   * completed on the period's days (cancelled ones aside), the emergencies,
   * the mean hours to complete, and its share of the tickets beside its
   * share of the units (whether service is spread fairly).
   */
  private async service(tx: TenantTxClient, q: ReportRequest) {
    const countable = await this.countable();
    const opened = inDays(Prisma.sql`k.created_at`, q);
    const completed = Prisma.sql`k.completed_at IS NOT NULL AND ${inDays(Prisma.sql`k.completed_at`, q)}`;
    const rows = await tx.$queryRaw<Cells[]>`
      WITH t AS (
        SELECT COALESCE(${TICKET_BUILDING}, '') AS b,
               count(*) FILTER (WHERE ${opened}) AS opened,
               count(*) FILTER (WHERE ${completed}) AS completed,
               count(*) FILTER (WHERE ${opened} AND k.priority = 'emergency') AS emergencies,
               AVG(EXTRACT(EPOCH FROM (k.completed_at - k.created_at)) / 3600)
                 FILTER (WHERE ${completed}) AS mttr
          FROM tickets k
          ${TICKET_PLACE}
         WHERE k.cancelled_at IS NULL AND ${countable}
           AND (${opened} OR (${completed}))
         GROUP BY 1
      ), n AS (
        SELECT COALESCE(building, '') AS b, count(*) AS units FROM units GROUP BY 1
      ), j AS (
        SELECT COALESCE(t.b, n.b) AS b, COALESCE(n.units, 0) AS units,
               COALESCE(t.opened, 0) AS opened, COALESCE(t.completed, 0) AS completed,
               COALESCE(t.emergencies, 0) AS emergencies, t.mttr
          FROM t FULL JOIN n ON n.b = t.b
      )
      SELECT NULLIF(b, '') AS building, units::text, opened::text, completed::text,
             emergencies::text, round(mttr::numeric, 1)::text AS mttr,
             CASE WHEN units > 0 THEN round(opened * 10.0 / units, 2)::text END AS per10,
             CASE WHEN SUM(opened) OVER () > 0
                  THEN round(opened * 100.0 / SUM(opened) OVER (), 1)::text END AS ticket_share,
             CASE WHEN SUM(units) OVER () > 0
                  THEN round(units * 100.0 / SUM(units) OVER (), 1)::text END AS unit_share
        FROM j
       ORDER BY b = '', b
       LIMIT ${LIMIT}`;
    return {
      rows: cells(rows, [
        'building',
        'units',
        'opened',
        'completed',
        'emergencies',
        'mttr',
        'per10',
        'ticket_share',
        'unit_share',
      ]),
    };
  }

  /**
   * Each building's use and cost of electricity, water and gas (ADR 0066:
   * the readings spread over their days, at the tariffs in force), over
   * the floor area of all its units (ADR 0072). No number where it would
   * mislead: without a tariff in force the cost is unknown (`no_tariff`);
   * with a unit of the building whose area is not recorded the area is
   * unknown (`no_area`), and so is the cost per m².
   */
  private async energy(tx: TenantTxClient, q: ReportRequest) {
    const areas = new Map(
      (
        await tx.$queryRaw<{ b: string; sqm: string; missing: bigint }[]>`
          SELECT COALESCE(building, '') AS b,
                 COALESCE(SUM(area_sqm), 0)::text AS sqm,
                 count(*) FILTER (WHERE area_sqm IS NULL OR area_sqm <= 0) AS missing
            FROM units GROUP BY 1`
      ).map((r) => [r.b, r]),
    );
    const out: (string | null)[][] = [];
    for (const kind of ENERGY_KINDS) {
      const report = await this.consumption.reportIn(
        tx,
        kind,
        'building',
        q.period,
      );
      for (const g of report.groups) {
        const area = areas.get(g.label ?? '');
        const sqm = area ? new Prisma.Decimal(area.sqm) : new Prisma.Decimal(0);
        const missing = area ? Number(area.missing) : 0;
        const known = g.label !== null && sqm.gt(0) && missing === 0;
        const note = g.cost === null ? 'no_tariff' : known ? null : 'no_area';
        out.push([
          g.label,
          kind,
          g.use,
          METER_UNITS[kind],
          g.cost,
          g.label !== null && sqm.gt(0) ? sqm.toFixed(2) : null,
          g.label !== null ? String(missing) : null,
          note === null
            ? new Prisma.Decimal(g.cost!).dividedBy(sqm).toFixed(2)
            : null,
          note,
        ]);
      }
    }
    return { rows: out };
  }
}
