import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { dateColumn, type LocalDate } from '../schedules/local-dates';
import { SensitiveTickets } from '../tickets/sensitive-tickets';
import { requirePeriod } from '../tickets/ticket-export';

export interface MapBuilding {
  buildingId: string;
  name: string;
  /** The building's common area's position (kind building), if it has one. */
  latitude: number | null;
  longitude: number | null;
  total: number;
  /** Neither closed nor cancelled now. */
  open: number;
  /** Opened by residents (the complaints proper). */
  residents: number;
  /** The five categories with the most, most first. */
  categories: { categoryKey: string; count: number }[];
}

export interface MapArea {
  commonAreaId: string;
  code: string;
  kind: string;
  latitude: number | null;
  longitude: number | null;
  total: number;
  open: number;
}

export interface ComplaintsMapRead {
  from: LocalDate;
  to: LocalDate;
  buildings: MapBuilding[];
  areas: MapArea[];
}

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/**
 * Where the tickets are (ADR 0081): over a period of the compound's days
 * (at most a year), per building of the register (ADR 0072: its units'
 * tickets, with its common area's position when it has one) and per common
 * area with tickets (its own and its assets', with its position). Counts,
 * codes and names of places only: never a unit, a ticket or a person, so a
 * bubble is opened through the ticket list's own filters. Cancelled
 * tickets are left out; a sensitive one counts only for `tickets.sensitive`.
 */
@Injectable()
export class ComplaintsMap {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly calendar: CompoundCalendar,
    private readonly sensitive: SensitiveTickets,
  ) {}

  async read(q: {
    from: LocalDate;
    to: LocalDate;
    categoryId?: string;
  }): Promise<ComplaintsMapRead> {
    requirePeriod(q.from, q.to);
    const hide = await this.sensitive.sql('t');
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timeZone } = await this.calendar.now(tx);
      const of: Prisma.Sql[] = [
        Prisma.sql`t.status <> 'cancelled'`,
        Prisma.sql`(t.created_at AT TIME ZONE ${timeZone})::date
                     BETWEEN ${dateColumn(q.from)}::date AND ${dateColumn(q.to)}::date`,
        ...(q.categoryId
          ? [Prisma.sql`t.category_id = ${q.categoryId}::uuid`]
          : []),
        ...hide,
      ];
      const tickets = Prisma.join(of, ' AND ');
      const buildings = await tx.$queryRaw<
        {
          id: string;
          name: string;
          latitude: Prisma.Decimal | null;
          longitude: Prisma.Decimal | null;
          total: bigint;
          open: bigint;
          residents: bigint;
        }[]
      >`
        WITH k AS (
          SELECT u.building_id, t.status, t.origin
            FROM tickets t JOIN units u ON u.id = t.unit_id
           WHERE u.building_id IS NOT NULL AND ${tickets}
        )
        SELECT b.id, b.name, pos.latitude, pos.longitude,
               count(k.building_id) AS total,
               count(k.building_id) FILTER (WHERE k.status NOT IN ('closed', 'cancelled')) AS open,
               count(k.building_id) FILTER (WHERE k.origin = 'resident') AS residents
          FROM buildings b
          LEFT JOIN LATERAL (
            SELECT ca.latitude, ca.longitude FROM common_areas ca
             WHERE ca.kind = 'building' AND ca.building = b.name AND ca.active
             ORDER BY ca.created_at, ca.id LIMIT 1) pos ON true
          LEFT JOIN k ON k.building_id = b.id
         GROUP BY b.id, b.name, pos.latitude, pos.longitude
         ORDER BY b.name, b.id`;
      const categories = await tx.$queryRaw<
        { building_id: string; category_key: string; n: bigint }[]
      >`
        SELECT building_id, category_key, n FROM (
          SELECT u.building_id, c.key AS category_key, count(*) AS n,
                 row_number() OVER (PARTITION BY u.building_id ORDER BY count(*) DESC, c.key) AS r
            FROM tickets t JOIN units u ON u.id = t.unit_id
            JOIN ticket_categories c ON c.id = t.category_id
           WHERE u.building_id IS NOT NULL AND ${tickets}
           GROUP BY u.building_id, c.key) x
         WHERE r <= 5
         ORDER BY building_id, n DESC, category_key`;
      const areas = await tx.$queryRaw<
        {
          id: string;
          code: string;
          kind: string;
          latitude: Prisma.Decimal | null;
          longitude: Prisma.Decimal | null;
          total: bigint;
          open: bigint;
        }[]
      >`
        WITH k AS (
          SELECT COALESCE(t.common_area_id, a.common_area_id) AS area_id, t.status
            FROM tickets t LEFT JOIN assets a ON a.id = t.asset_id
           WHERE t.unit_id IS NULL AND ${tickets}
        )
        SELECT ca.id, ca.code, ca.kind, ca.latitude, ca.longitude,
               count(*) AS total,
               count(*) FILTER (WHERE k.status NOT IN ('closed', 'cancelled')) AS open
          FROM k JOIN common_areas ca ON ca.id = k.area_id
         GROUP BY ca.id, ca.code, ca.kind, ca.latitude, ca.longitude
         ORDER BY total DESC, ca.code`;
      const byBuilding = new Map<
        string,
        { categoryKey: string; count: number }[]
      >();
      for (const c of categories)
        byBuilding.set(c.building_id, [
          ...(byBuilding.get(c.building_id) ?? []),
          { categoryKey: c.category_key, count: Number(c.n) },
        ]);
      return {
        from: q.from,
        to: q.to,
        buildings: buildings.map((b) => ({
          buildingId: b.id,
          name: b.name,
          latitude: num(b.latitude),
          longitude: num(b.longitude),
          total: Number(b.total),
          open: Number(b.open),
          residents: Number(b.residents),
          categories: byBuilding.get(b.id) ?? [],
        })),
        areas: areas.map((a) => ({
          commonAreaId: a.id,
          code: a.code,
          kind: a.kind,
          latitude: num(a.latitude),
          longitude: num(a.longitude),
          total: Number(a.total),
          open: Number(a.open),
        })),
      };
    });
  }
}
