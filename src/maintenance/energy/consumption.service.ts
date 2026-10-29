import { Injectable } from '@nestjs/common';
import { Prisma, type Meter } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { toCsv } from '../../core/common/csv';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { resolvePeriod, type Period } from '../economics/period';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { ofDateColumn, type LocalDate } from '../schedules/local-dates';
import {
  amount,
  money,
  spread,
  type ConsumptionGroup,
  type Segment,
  type TariffPoint,
} from './consumption-rules';
import { METER_UNITS, type MeterKind, type MeterMode } from './meter-rules';
import { meterNotFound } from './meters.service';
import { periodUse } from './reading-rules';

export interface UsePart {
  month: string;
  use: string;
  /** EGP at the tariffs in force; null where none was. */
  cost: string | null;
}

export interface ConsumptionGroupRead {
  /** The meter's id, the building's name, the common area's id; null: none. */
  key: string | null;
  /** The meter's code, the building, the area's code. */
  label: string | null;
  meters: number;
  use: string;
  cost: string | null;
  /** Use a square metre of the units' floor area, when there is one. */
  perSqm: string | null;
  /** Use an occupied unit, when one is (buildings and meters in units). */
  perOccupiedUnit: string | null;
  months: UsePart[];
}

export interface ConsumptionReport {
  kind: MeterKind;
  unit: string;
  groupBy: ConsumptionGroup;
  period: Period;
  use: string;
  cost: string | null;
  groups: ConsumptionGroupRead[];
}

interface PeriodRow {
  meter_id: string;
  prev_on: string;
  read_on: string;
  prev_value: string;
  value: string;
  reset: boolean;
}

interface Bucket {
  key: string | null;
  label: string | null;
  meters: Set<string>;
  units: Set<string>;
  segments: Segment[];
}

/**
 * Consumption (ADR 0066), computed on read from the live readings — nothing
 * stored to go stale. Each period between two live readings is spread
 * evenly over its days; the part inside the window counts, by month, at
 * the tariff in force each day. Grouped by meter, by building (a unit's,
 * or a building-kind common area's) or by common area, with use per square
 * metre and per occupied unit to compare buildings by. Read with
 * `energy.read`: a unit's use shows when it stands empty.
 */
@Injectable()
export class ConsumptionService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly calendar: CompoundCalendar,
    private readonly community: CommunityMaintenancePort,
  ) {}

  report(q: {
    kind: MeterKind;
    groupBy?: ConsumptionGroup;
    from?: string;
    to?: string;
  }): Promise<ConsumptionReport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today } = await this.calendar.now(tx);
      const period = resolvePeriod(q, today);
      const groupBy = q.groupBy ?? 'building';
      const meters = await tx.meter.findMany({
        where: { kind: q.kind },
        orderBy: { code: 'asc' },
      });
      return this.build(tx, q.kind, groupBy, period, meters);
    });
  }

  /** One meter's use over a period, by month. */
  ofMeter(
    meterId: string,
    q: { from?: string; to?: string },
  ): Promise<ConsumptionReport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const meter = await tx.meter.findUnique({ where: { id: meterId } });
      if (!meter) throw meterNotFound();
      const { today } = await this.calendar.now(tx);
      return this.build(
        tx,
        meter.kind as MeterKind,
        'meter',
        resolvePeriod(q, today),
        [meter],
      );
    });
  }

  /** The report as CSV, one row a group and month. */
  async csv(q: {
    kind: MeterKind;
    groupBy?: ConsumptionGroup;
    from?: string;
    to?: string;
  }): Promise<Buffer> {
    const r = await this.report(q);
    return toCsv(
      [
        { header: 'group', kind: 'text' },
        { header: 'month', kind: 'text' },
        { header: `use (${r.unit})`, kind: 'number' },
        { header: 'cost (EGP)', kind: 'number' },
      ],
      r.groups.flatMap((g) =>
        g.months.map((m) => [g.label ?? '', m.month, m.use, m.cost]),
      ),
    );
  }

  /** The use of a kind over a window, on one meter, one building or all. */
  async useOver(
    tx: TenantTxClient,
    kind: MeterKind,
    scope: { meterId?: string | null; building?: string | null },
    window: { from: LocalDate; to: LocalDate },
  ): Promise<Prisma.Decimal> {
    const meters = await tx.meter.findMany({
      where: {
        kind,
        ...(scope.meterId ? { id: scope.meterId } : {}),
      },
    });
    const kept = scope.building
      ? await this.inBuilding(tx, meters, scope.building)
      : meters;
    const segments = await this.segments(tx, kept, window, []);
    return segments.reduce(
      (s, x) => s.plus(x.segment.use),
      new Prisma.Decimal(0),
    );
  }

  private async build(
    tx: TenantTxClient,
    kind: MeterKind,
    groupBy: ConsumptionGroup,
    period: Period,
    meters: Meter[],
  ): Promise<ConsumptionReport> {
    const tariffs = (
      await tx.energyTariff.findMany({
        where: { kind },
        orderBy: { effectiveOn: 'asc' },
      })
    ).map((t): TariffPoint => ({
      effectiveOn: ofDateColumn(t.effectiveOn),
      pricePerUnit: t.pricePerUnit,
    }));
    const units = await this.community.energyUnits(
      tx,
      meters.flatMap((m) => (m.unitId ? [m.unitId] : [])),
    );
    const areas = new Map(
      (
        await tx.commonArea.findMany({
          where: {
            id: {
              in: meters.flatMap((m) =>
                m.commonAreaId ? [m.commonAreaId] : [],
              ),
            },
          },
          select: { id: true, code: true, building: true },
        })
      ).map((a) => [a.id, a]),
    );
    const buckets = new Map<string, Bucket>();
    const bucketOf = (m: Meter): Bucket => {
      const area = m.commonAreaId ? areas.get(m.commonAreaId) : undefined;
      const unit = m.unitId ? units.get(m.unitId) : undefined;
      const [key, label] =
        groupBy === 'meter'
          ? [m.id, m.code]
          : groupBy === 'building'
            ? [
                unit?.building ?? area?.building ?? null,
                unit?.building ?? area?.building ?? null,
              ]
            : [m.commonAreaId, area?.code ?? null];
      const id = key ?? '';
      if (!buckets.has(id))
        buckets.set(id, {
          key,
          label,
          meters: new Set(),
          units: new Set(),
          segments: [],
        });
      const b = buckets.get(id)!;
      b.meters.add(m.id);
      if (m.unitId) b.units.add(m.unitId);
      return b;
    };
    const byId = new Map(meters.map((m) => [m.id, m]));
    for (const m of meters) bucketOf(m);
    for (const { meterId, segment } of await this.segments(
      tx,
      meters,
      period,
      tariffs,
    ))
      bucketOf(byId.get(meterId)!).segments.push(segment);
    const groups = [...buckets.values()]
      .map((b) => this.group(b, units))
      .sort((a, b) => (a.label ?? '￿').localeCompare(b.label ?? '￿'));
    const all = [...buckets.values()].flatMap((b) => b.segments);
    return {
      kind,
      unit: METER_UNITS[kind],
      groupBy,
      period,
      use: amount(sum(all.map((s) => s.use))),
      cost: costOf(all),
      groups,
    };
  }

  private group(
    b: Bucket,
    units: Map<string, { areaSqm: Prisma.Decimal | null; occupied: boolean }>,
  ): ConsumptionGroupRead {
    const use = sum(b.segments.map((s) => s.use));
    const sqm = sum(
      [...b.units].map((u) => units.get(u)?.areaSqm ?? new Prisma.Decimal(0)),
    );
    const occupied = [...b.units].filter((u) => units.get(u)?.occupied).length;
    const months = new Map<string, Segment[]>();
    for (const s of b.segments)
      months.set(s.month, [...(months.get(s.month) ?? []), s]);
    return {
      key: b.key,
      label: b.label,
      meters: b.meters.size,
      use: amount(use),
      cost: costOf(b.segments),
      perSqm: sqm.gt(0) ? amount(use.dividedBy(sqm)) : null,
      perOccupiedUnit: occupied ? amount(use.dividedBy(occupied)) : null,
      months: [...months.entries()]
        .sort(([a], [z]) => (a < z ? -1 : 1))
        .map(([month, ss]) => ({
          month,
          use: amount(sum(ss.map((s) => s.use))),
          cost: costOf(ss),
        })),
    };
  }

  /**
   * Every period between consecutive live readings of the meters that
   * reaches into the window, spread over its days and cut by month and
   * tariff: LAG over each meter's live readings.
   */
  private async segments(
    tx: TenantTxClient,
    meters: readonly Meter[],
    window: { from: LocalDate; to: LocalDate },
    tariffs: readonly TariffPoint[],
  ): Promise<{ meterId: string; segment: Segment }[]> {
    if (!meters.length) return [];
    const ids = meters.map((m) => m.id);
    const rows = await tx.$queryRaw<PeriodRow[]>`
      SELECT meter_id, prev_on::text, read_on::text, prev_value::text, value::text, reset
        FROM (SELECT r.meter_id, r.read_on, r.value, r.reset,
                     LAG(r.read_on) OVER w AS prev_on,
                     LAG(r.value) OVER w AS prev_value
                FROM meter_readings r
               WHERE r.superseded_at IS NULL AND r.meter_id = ANY(${ids}::uuid[])
              WINDOW w AS (PARTITION BY r.meter_id ORDER BY r.read_on)) p
       WHERE prev_on IS NOT NULL
         AND read_on >= ${window.from}::date AND prev_on < ${window.to}::date`;
    const byId = new Map(meters.map((m) => [m.id, m]));
    return rows.flatMap((r) => {
      const m = byId.get(r.meter_id)!;
      const use = periodUse(
        m.mode as MeterMode,
        m.multiplier,
        {
          readOn: r.prev_on,
          value: new Prisma.Decimal(r.prev_value),
          reset: false,
        },
        {
          readOn: r.read_on,
          value: new Prisma.Decimal(r.value),
          reset: r.reset,
        },
      );
      return spread(
        { from: r.prev_on, to: r.read_on, use },
        window,
        tariffs,
      ).map((segment) => ({ meterId: m.id, segment }));
    });
  }

  private async inBuilding(
    tx: TenantTxClient,
    meters: Meter[],
    building: string,
  ): Promise<Meter[]> {
    const units = await this.community.energyUnits(
      tx,
      meters.flatMap((m) => (m.unitId ? [m.unitId] : [])),
    );
    const areas = new Set(
      (
        await tx.commonArea.findMany({
          where: { building },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    return meters.filter((m) =>
      m.unitId
        ? units.get(m.unitId)?.building === building
        : areas.has(m.commonAreaId!),
    );
  }
}

const sum = (xs: readonly Prisma.Decimal[]) =>
  xs.reduce((s, x) => s.plus(x), new Prisma.Decimal(0));

/** Money of the priced segments, or null when none was priced. */
function costOf(ss: readonly Segment[]): string | null {
  const priced = ss.filter((s) => s.cost !== null);
  return priced.length ? money(sum(priced.map((s) => s.cost!))) : null;
}
