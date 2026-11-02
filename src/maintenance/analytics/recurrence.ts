import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { dateColumn, type LocalDate } from '../schedules/local-dates';
import { SensitiveTickets } from '../tickets/sensitive-tickets';
import { requirePeriod } from '../tickets/ticket-export';

/** Where repeat faults are counted (ADR 0081). */
export const RECURRENCE_PLACES = [
  'asset',
  'unit',
  'building',
  'common_area',
] as const;
export type RecurrencePlace = (typeof RECURRENCE_PLACES)[number];

/** At most this many rows; `truncated` says there were more. */
export const RECURRENCE_MAX_ROWS = 500;

export interface RecurrenceRow {
  placeId: string;
  /** The asset's or unit's or area's code, the building's name; null once gone. */
  placeCode: string | null;
  categoryId: string;
  categoryKey: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
  /** Days between the first and the last, over the gaps between them. */
  meanIntervalDays: number;
  /** EGP: the recorded costs of those tickets, voided ones left out. */
  cost: string;
  months: { month: string; count: number }[];
}

export interface RecurrenceReport {
  from: LocalDate;
  to: LocalDate;
  by: RecurrencePlace;
  min: number;
  truncated: boolean;
  rows: RecurrenceRow[];
}

interface Row {
  place_id: string;
  category_id: string;
  category_key: string;
  n: bigint;
  first_at: Date;
  last_at: Date;
  cost: Prisma.Decimal;
  months: { month: string; count: number }[];
}

/**
 * Repeat faults (ADR 0081): over a period of the compound's days (at most a
 * year), the repairs of each category at each place — an asset, a unit, a
 * building (its units'), a common area (its own and its assets') — from
 * `min` tickets on (the compound's `recurrence_min_tickets` unless asked):
 * how many, the first and the last, the mean gap, what they cost, and how
 * many a month. A plan's own work orders, check-ups and cancelled tickets
 * are not faults. Aggregated in SQL; codes, counts and amounts only. A
 * sensitive ticket counts only for `tickets.sensitive`.
 */
@Injectable()
export class RecurrenceReports {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly calendar: CompoundCalendar,
    private readonly sensitive: SensitiveTickets,
  ) {}

  async report(q: {
    from: LocalDate;
    to: LocalDate;
    by?: RecurrencePlace;
    categoryId?: string;
    min?: number;
  }): Promise<RecurrenceReport> {
    requirePeriod(q.from, q.to);
    const by = q.by ?? 'asset';
    const hide = await this.sensitive.sql('t');
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timeZone } = await this.calendar.now(tx);
      const min =
        q.min ??
        (
          await tx.maintenanceSettings.findUniqueOrThrow({
            where: { tenantId: this.ctx.tenantId },
          })
        ).recurrenceMinTickets;
      const place = {
        asset: Prisma.sql`t.asset_id`,
        unit: Prisma.sql`t.unit_id`,
        building: Prisma.sql`u.building_id`,
        common_area: Prisma.sql`COALESCE(t.common_area_id, a.common_area_id)`,
      }[by];
      const where: Prisma.Sql[] = [
        Prisma.sql`t.kind = 'repair'`,
        Prisma.sql`t.origin <> 'plan'`,
        Prisma.sql`t.status <> 'cancelled'`,
        Prisma.sql`(t.created_at AT TIME ZONE ${timeZone})::date
                     BETWEEN ${dateColumn(q.from)}::date AND ${dateColumn(q.to)}::date`,
        ...(q.categoryId
          ? [Prisma.sql`t.category_id = ${q.categoryId}::uuid`]
          : []),
        ...hide,
      ];
      const rows = await tx.$queryRaw<Row[]>`
        WITH k AS (
          SELECT t.id, t.category_id, t.created_at, ${place} AS place_id,
                 to_char(t.created_at AT TIME ZONE ${timeZone}, 'YYYY-MM') AS month
            FROM tickets t
            LEFT JOIN units u ON u.id = t.unit_id
            LEFT JOIN assets a ON a.id = t.asset_id
           WHERE ${Prisma.join(where, ' AND ')}
        ),
        g AS (
          SELECT place_id, category_id, count(*) AS n,
                 min(created_at) AS first_at, max(created_at) AS last_at
            FROM k WHERE place_id IS NOT NULL
           GROUP BY place_id, category_id
          HAVING count(*) >= ${min}
        ),
        m AS (
          SELECT place_id, category_id,
                 json_agg(json_build_object('month', month, 'count', c) ORDER BY month) AS months
            FROM (SELECT place_id, category_id, month, count(*)::int AS c
                    FROM k GROUP BY place_id, category_id, month) x
           GROUP BY place_id, category_id
        ),
        c AS (
          SELECT k.place_id, k.category_id, sum(e.amount) AS cost
            FROM k JOIN ticket_cost_entries e ON e.ticket_id = k.id AND e.voided_at IS NULL
           GROUP BY k.place_id, k.category_id
        )
        SELECT g.place_id, g.category_id, cat.key AS category_key, g.n,
               g.first_at, g.last_at, COALESCE(c.cost, 0) AS cost, m.months
          FROM g
          JOIN m ON m.place_id = g.place_id AND m.category_id = g.category_id
          LEFT JOIN c ON c.place_id = g.place_id AND c.category_id = g.category_id
          JOIN ticket_categories cat ON cat.id = g.category_id
         ORDER BY g.n DESC, cost DESC, g.place_id, g.category_id
         LIMIT ${RECURRENCE_MAX_ROWS + 1}`;
      const kept = rows.slice(0, RECURRENCE_MAX_ROWS);
      const codes = await placeCodes(
        tx,
        by,
        kept.map((r) => r.place_id),
      );
      return {
        from: q.from,
        to: q.to,
        by,
        min,
        truncated: rows.length > RECURRENCE_MAX_ROWS,
        rows: kept.map((r) => {
          const n = Number(r.n);
          const span = r.last_at.getTime() - r.first_at.getTime();
          return {
            placeId: r.place_id,
            placeCode: codes.get(r.place_id) ?? null,
            categoryId: r.category_id,
            categoryKey: r.category_key,
            count: n,
            firstAt: r.first_at,
            lastAt: r.last_at,
            meanIntervalDays:
              Math.round((span / (n - 1) / 86_400_000) * 10) / 10,
            cost: new Prisma.Decimal(r.cost).toFixed(2),
            months: r.months,
          };
        }),
      };
    });
  }
}

/** The places' codes (a building's name), in one read. */
async function placeCodes(
  tx: TenantTxClient,
  by: RecurrencePlace,
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const where = { id: { in: ids } };
  const rows =
    by === 'asset'
      ? (
          await tx.asset.findMany({ where, select: { id: true, code: true } })
        ).map((r) => [r.id, r.code] as const)
      : by === 'unit'
        ? (
            await tx.unit.findMany({ where, select: { id: true, code: true } })
          ).map((r) => [r.id, r.code] as const)
        : by === 'building'
          ? (
              await tx.building.findMany({
                where,
                select: { id: true, name: true },
              })
            ).map((r) => [r.id, r.name] as const)
          : (
              await tx.commonArea.findMany({
                where,
                select: { id: true, code: true },
              })
            ).map((r) => [r.id, r.code] as const);
  return new Map(rows);
}
