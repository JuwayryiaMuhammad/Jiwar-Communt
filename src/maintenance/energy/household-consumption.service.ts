import { Injectable } from '@nestjs/common';
import { Prisma, type Meter } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { resolvePeriod, type Period } from '../economics/period';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { compoundDay, type LocalDate } from '../schedules/local-dates';
import { amount, money, monthOf } from './consumption-rules';
import { ConsumptionService } from './consumption.service';
import {
  addMonths,
  BENCHMARK_MIN_UNITS,
  daysIn,
  firstDay,
  householdMonths,
  lastDay,
  median,
  type HouseholdMonth,
} from './household-consumption-rules';
import { METER_UNITS, type MeterKind } from './meter-rules';

export interface HouseholdMonthRead {
  month: string;
  use: string;
  estimatedCost: string | null;
  complete: boolean;
}

export interface HouseholdKindRead {
  kind: MeterKind;
  unit: string;
  meters: number;
  use: string;
  estimatedCost: string | null;
  months: HouseholdMonthRead[];
  /** The latest complete month against the one before and a year before. */
  compare: {
    month: string;
    use: string;
    previousMonth: { month: string; use: string } | null;
    sameMonthLastYear: { month: string; use: string } | null;
  } | null;
}

export interface HouseholdConsumption {
  unitId: string;
  /** The household's first day: nothing before it is read. */
  since: LocalDate;
  period: Period;
  kinds: HouseholdKindRead[];
}

export type BenchmarkUnavailable = 'TOO_FEW_UNITS' | 'NO_BUILDING';

export interface ConsumptionBenchmark {
  kind: MeterKind;
  unit: string;
  month: string;
  available: boolean;
  reason: BenchmarkUnavailable | null;
  /** How many other units it compares: at least BENCHMARK_MIN_UNITS. */
  units: number | null;
  medianPerSqmDay: string | null;
  meanPerSqmDay: string | null;
  /** The household's own, when its month is complete and its unit has an area. */
  mine: string | null;
}

const consumptionNotAllowed = () =>
  appError.forbidden(
    ErrorCode.CONSUMPTION_NOT_ALLOWED,
    'Only the household that lives there reads its consumption',
  );

/**
 * A household's own consumption (ADR 0069), read through its unit: the
 * unit's meters belong to the unit, never an account, and are read only
 * over the tenure of the household living there now — periods between
 * two readings on or after the day it came, so nothing of a household
 * before it shows. Its months compare with each other; against other
 * homes, only as an aggregate of at least five other units of its
 * building. Who reads it: `consumptionView` — who lives there, or a
 * member given `finance`; never a landlord.
 */
@Injectable()
export class HouseholdConsumptionService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly calendar: CompoundCalendar,
    private readonly community: CommunityMaintenancePort,
    private readonly consumption: ConsumptionService,
  ) {}

  read(
    unitId: string,
    q: { kind?: MeterKind; from?: string; to?: string },
  ): Promise<HouseholdConsumption> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const since = await this.since(tx, unitId);
      const { today } = await this.calendar.now(tx);
      const period = resolvePeriod(q, today);
      const meters = await tx.meter.findMany({
        where: { unitId, ...(q.kind ? { kind: q.kind } : {}) },
        orderBy: [{ kind: 'asc' }, { code: 'asc' }],
      });
      const kinds = [...new Set(meters.map((m) => m.kind as MeterKind))];
      const out: HouseholdKindRead[] = [];
      for (const kind of kinds)
        out.push(
          await this.kindRead(
            tx,
            kind,
            meters.filter((m) => m.kind === kind),
            period,
            since,
          ),
        );
      return { unitId, since, period, kinds: out };
    });
  }

  benchmark(
    unitId: string,
    q: { kind: MeterKind; month: string },
  ): Promise<ConsumptionBenchmark> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const since = await this.since(tx, unitId);
      const { today, timeZone } = await this.calendar.now(tx);
      const latest = addMonths(monthOf(today), -1);
      if (q.month > latest)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Only a month that has ended',
          {
            fields: [
              {
                field: 'month',
                code: FieldErrorCode.INVALID_VALUE,
                params: { latest },
              },
            ],
          },
        );
      const none = (reason: BenchmarkUnavailable): ConsumptionBenchmark => ({
        kind: q.kind,
        unit: METER_UNITS[q.kind],
        month: q.month,
        available: false,
        reason,
        units: null,
        medianPerSqmDay: null,
        meanPerSqmDay: null,
        mine: null,
      });
      const own = (await this.community.energyUnits(tx, [unitId])).get(unitId);
      if (!own?.building) return none('NO_BUILDING');
      const units = await this.community.benchmarkUnits(tx, own.building);
      const sinceDay = new Map(
        units.map((u) => [u.id, compoundDay(u.since, timeZone)]),
      );
      // The household's own unit, even without a floor area (then `mine`
      // is null): read over its own tenure, like every other.
      sinceDay.set(unitId, since);
      const month = { from: firstDay(q.month), to: lastDay(q.month) };
      const meters = await tx.meter.findMany({
        where: {
          kind: q.kind,
          unitId: { in: [...new Set([unitId, ...units.map((u) => u.id)])] },
        },
      });
      const parts = await this.consumption.householdSegments(
        tx,
        meters,
        month,
        [],
        (m) => sinceDay.get(m.unitId!)!,
      );
      const perSqmDay = (
        id: string,
        area: Prisma.Decimal | null,
      ): Prisma.Decimal | null => {
        const ids = new Set(
          meters.filter((m) => m.unitId === id).map((m) => m.id),
        );
        const [m] = householdMonths(parts.filter((p) => ids.has(p.meterId)));
        if (!m?.complete || !area || area.lte(0)) return null;
        return m.use.dividedBy(area).dividedBy(daysIn(q.month));
      };
      const others = units
        .filter((u) => u.id !== unitId && sinceDay.get(u.id)! <= month.from)
        .flatMap((u) => {
          const v = perSqmDay(u.id, u.areaSqm);
          return v ? [v] : [];
        });
      if (others.length < BENCHMARK_MIN_UNITS) return none('TOO_FEW_UNITS');
      const mine = since <= month.from ? perSqmDay(unitId, own.areaSqm) : null;
      return {
        kind: q.kind,
        unit: METER_UNITS[q.kind],
        month: q.month,
        available: true,
        reason: null,
        units: others.length,
        medianPerSqmDay: amount(median(others)!),
        meanPerSqmDay: amount(
          others
            .reduce((n, v) => n.plus(v), new Prisma.Decimal(0))
            .dividedBy(others.length),
        ),
        mine: mine ? amount(mine) : null,
      };
    });
  }

  /**
   * The household's first day, for a caller who reads the unit's
   * consumption: no place there is not found; a place without
   * `consumptionView` (a landlord) is refused.
   */
  private async since(tx: TenantTxClient, unitId: string): Promise<LocalDate> {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps?.unitView)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    if (!caps.consumptionView) throw consumptionNotAllowed();
    const since = await this.community.householdSince(tx, unitId);
    // A member reads while someone lives there; with nobody, nothing.
    if (!since) throw consumptionNotAllowed();
    const { timeZone } = await this.calendar.now(tx);
    return compoundDay(since, timeZone);
  }

  private async kindRead(
    tx: TenantTxClient,
    kind: MeterKind,
    meters: Meter[],
    period: Period,
    since: LocalDate,
  ): Promise<HouseholdKindRead> {
    const tariffs = await this.consumption.tariffsOf(tx, kind);
    const sinceOf = () => since;
    const from = period.from < since ? since : period.from;
    const months =
      from <= period.to
        ? householdMonths(
            await this.consumption.householdSegments(
              tx,
              meters,
              { from, to: period.to },
              tariffs,
              sinceOf,
            ),
          )
        : [];
    const latest = [...months].reverse().find((m) => m.complete);
    let compare: HouseholdKindRead['compare'] = null;
    if (latest) {
      const yearBefore = addMonths(latest.month, -12);
      const wide = {
        from: firstDay(yearBefore) < since ? since : firstDay(yearBefore),
        to: lastDay(addMonths(latest.month, -1)),
      };
      const before =
        wide.from <= wide.to
          ? householdMonths(
              await this.consumption.householdSegments(
                tx,
                meters,
                wide,
                [],
                sinceOf,
              ),
            )
          : [];
      const full = (month: string) => {
        const m = before.find((x) => x.month === month && x.complete);
        return m ? { month, use: amount(m.use) } : null;
      };
      compare = {
        month: latest.month,
        use: amount(latest.use),
        previousMonth: full(addMonths(latest.month, -1)),
        sameMonthLastYear: full(yearBefore),
      };
    }
    return {
      kind,
      unit: METER_UNITS[kind],
      meters: meters.length,
      use: amount(sum(months.map((m) => m.use))),
      estimatedCost: costOf(months),
      months: months.map((m) => ({
        month: m.month,
        use: amount(m.use),
        estimatedCost: m.cost ? money(m.cost) : null,
        complete: m.complete,
      })),
      compare,
    };
  }
}

const sum = (xs: readonly Prisma.Decimal[]) =>
  xs.reduce((s, x) => s.plus(x), new Prisma.Decimal(0));

function costOf(ms: readonly HouseholdMonth[]): string | null {
  const priced = ms.filter((m) => m.cost !== null);
  return priced.length ? money(sum(priced.map((m) => m.cost!))) : null;
}
