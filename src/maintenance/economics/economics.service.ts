import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { assetNotFound } from '../assets/assets.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  ofDateColumn,
  wholeYears,
  type LocalDate,
} from '../schedules/local-dates';
import { MaintenanceSettingsService } from '../settings/maintenance-settings.service';
import {
  capitalPlan,
  daysBetween,
  downtimeCost,
  ratio,
  replacementAdvice,
  replacementYear,
  straightLineReserve,
  type AdviceReason,
  type ReplacementAdvice,
} from './economics-rules';
import { resolvePeriod, type Period } from './period';

const ZERO = new Prisma.Decimal(0);
const d = (v: Prisma.Decimal | string | number | null | undefined) =>
  v === null || v === undefined ? ZERO : new Prisma.Decimal(v);

export interface SpendSplit {
  total: Prisma.Decimal;
  labour: Prisma.Decimal;
  contractor: Prisma.Decimal;
  parts: Prisma.Decimal;
  other: Prisma.Decimal;
  /** A plan's work orders and residents' check-ups. */
  planned: Prisma.Decimal;
  /** Everything else: repairs. */
  corrective: Prisma.Decimal;
}

export interface AssetEconomics {
  assetId: string;
  cumulative: SpendSplit;
  lastYear: Prisma.Decimal;
  /** Corrective tickets on it, ever, not cancelled. */
  failures: number;
  /** Days its corrective tickets stood open, together. */
  downtimeDays: number;
  downtimeCost: Prisma.Decimal | null;
  /** Mean days between failures since it was commissioned (or recorded). */
  mtbfDays: number | null;
  ageYears: number | null;
  lifeYears: number | null;
  replacementCost: Prisma.Decimal | null;
  replacementYear: number | null;
  advice: ReplacementAdvice;
  reasons: AdviceReason[];
  reserve: { annual: Prisma.Decimal; accrued: Prisma.Decimal } | null;
}

export interface CompoundEconomics {
  period: Period;
  spend: SpendSplit;
  byMonth: { month: string; amount: Prisma.Decimal }[];
  byCategory: { categoryKey: string; amount: Prisma.Decimal }[];
  topAssets: { assetId: string; code: string; amount: Prisma.Decimal }[];
  capitalPlan: { year: number; amount: Prisma.Decimal; assets: number }[];
  reserve: { annual: Prisma.Decimal; accrued: Prisma.Decimal };
}

export interface MaintenanceKpis {
  period: Period;
  completedPlanned: number;
  completedCorrective: number;
  /** Planned over all completed work. */
  plannedShare: number | null;
  /** Mean hours from opening to completion of corrective work. */
  mttrHours: number | null;
  /** Corrective tickets opened on assets in the period. */
  failures: number;
  /** Asset-days in service over failures. */
  mtbfDays: number | null;
  /** Plan occurrences due in the period up to today, skipped ones aside. */
  occurrencesDue: number;
  occurrencesOnTime: number;
  compliance: number | null;
}

/** Planned work: a plan's work order or a resident's check-up. */
const PLANNED = Prisma.sql`(k.origin = 'plan' OR k.kind = 'preventive')`;

/**
 * Asset economics and the maintenance KPIs (ADR 0065), computed on read
 * from the tickets, their cost entries (voided ones aside) and the plans'
 * occurrences — nothing stored to go stale. Rules, not models: repair or
 * replace by the two rules of `replacementAdvice`, the capital plan by
 * commissioning year plus expected life, the reserve straight-line.
 * Periods are the compound's days; read with `assets.manage`.
 */
@Injectable()
export class EconomicsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly calendar: CompoundCalendar,
    private readonly settings: MaintenanceSettingsService,
  ) {}

  /** One asset: what it cost, its downtime, its age, the advice. */
  asset(assetId: string): Promise<AssetEconomics> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (!asset) throw assetNotFound();
      const type = await tx.assetType.findUniqueOrThrow({
        where: { id: asset.typeId },
      });
      const { now, today } = await this.calendar.now(tx);
      const { replaceCostSharePct } = await this.settings.inTx(tx);
      const [spend] = await tx.$queryRaw<SpendRow[]>`
        SELECT ${SPEND_COLUMNS},
               COALESCE(SUM(e.amount) FILTER (
                 WHERE e.entered_at >= ${now}::timestamptz - interval '12 months'), 0) AS last_year
          FROM ticket_cost_entries e JOIN tickets k ON k.id = e.ticket_id
         WHERE k.asset_id = ${assetId}::uuid AND e.voided_at IS NULL`;
      const [down] = await tx.$queryRaw<
        { failures: bigint; seconds: number | null }[]
      >`
        SELECT count(*) AS failures,
               SUM(EXTRACT(EPOCH FROM (COALESCE(k.completed_at, ${now}::timestamptz) - k.created_at)))::float8 AS seconds
          FROM tickets k
         WHERE k.asset_id = ${assetId}::uuid AND NOT ${PLANNED}
           AND k.cancelled_at IS NULL`;
      const failures = Number(down.failures);
      const downtimeDays = (down.seconds ?? 0) / 86_400;
      const since = asset.commissionedOn
        ? ofDateColumn(asset.commissionedOn)
        : null;
      const ageYears = since === null ? null : wholeYears(since, today);
      const lifeYears = asset.expectedLifeYears ?? type.expectedLifeYears;
      const inService = daysBetween(
        asset.commissionedOn ?? asset.createdAt,
        asset.retiredAt ?? now,
      );
      const cumulative = split(spend);
      const lastYear = d(spend.last_year);
      const { advice, reasons } = replacementAdvice({
        replacementCost: asset.replacementCost,
        cumulative: cumulative.total,
        lastYear,
        ageYears,
        lifeYears,
        sharePct: replaceCostSharePct,
      });
      return {
        assetId,
        cumulative,
        lastYear,
        failures,
        downtimeDays,
        downtimeCost: downtimeCost(downtimeDays, asset.downtimeCostPerDay),
        mtbfDays: failures ? inService / failures : null,
        ageYears,
        lifeYears,
        replacementCost: asset.replacementCost,
        replacementYear: replacementYear(
          since === null ? null : Number(since.slice(0, 4)),
          lifeYears,
        ),
        advice,
        reasons,
        reserve: straightLineReserve({
          replacementCost: asset.replacementCost,
          ageYears,
          lifeYears,
        }),
      };
    });
  }

  /** The compound over a period: spend, its split, top assets, the plan ahead. */
  compound(q: { from?: string; to?: string }): Promise<CompoundEconomics> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today, timeZone } = await this.calendar.now(tx);
      const period = resolvePeriod(q, today);
      const inPeriod = Prisma.sql`e.voided_at IS NULL
        AND (e.entered_at AT TIME ZONE ${timeZone})::date
            BETWEEN ${period.from}::date AND ${period.to}::date`;
      const [spend] = await tx.$queryRaw<SpendRow[]>`
        SELECT ${SPEND_COLUMNS}
          FROM ticket_cost_entries e JOIN tickets k ON k.id = e.ticket_id
         WHERE ${inPeriod}`;
      const byMonth = await tx.$queryRaw<{ month: string; amount: string }[]>`
        SELECT to_char(e.entered_at AT TIME ZONE ${timeZone}, 'YYYY-MM') AS month,
               SUM(e.amount)::text AS amount
          FROM ticket_cost_entries e
         WHERE ${inPeriod}
         GROUP BY 1 ORDER BY 1`;
      const byCategory = await tx.$queryRaw<
        { category_key: string; amount: string }[]
      >`
        SELECT c.key AS category_key, SUM(e.amount)::text AS amount
          FROM ticket_cost_entries e
          JOIN tickets k ON k.id = e.ticket_id
          JOIN ticket_categories c ON c.id = k.category_id
         WHERE ${inPeriod}
         GROUP BY c.key ORDER BY SUM(e.amount) DESC, c.key`;
      const top = await tx.$queryRaw<
        { asset_id: string; code: string; amount: string }[]
      >`
        SELECT a.id AS asset_id, a.code, SUM(e.amount)::text AS amount
          FROM ticket_cost_entries e
          JOIN tickets k ON k.id = e.ticket_id
          JOIN assets a ON a.id = k.asset_id
         WHERE ${inPeriod}
         GROUP BY a.id, a.code ORDER BY SUM(e.amount) DESC, a.code LIMIT 10`;
      const assets = await tx.asset.findMany({
        where: { status: { not: 'retired' }, replacementCost: { not: null } },
        select: {
          commissionedOn: true,
          expectedLifeYears: true,
          replacementCost: true,
          typeId: true,
        },
      });
      const lives = new Map(
        (
          await tx.assetType.findMany({
            select: { id: true, expectedLifeYears: true },
          })
        ).map((t) => [t.id, t.expectedLifeYears]),
      );
      const year = Number(today.slice(0, 4));
      const rows = assets.map((a) => {
        const life = a.expectedLifeYears ?? lives.get(a.typeId) ?? null;
        const since = a.commissionedOn ? ofDateColumn(a.commissionedOn) : null;
        return {
          dueYear: replacementYear(
            since === null ? null : Number(since.slice(0, 4)),
            life,
          ),
          replacementCost: a.replacementCost,
          reserve: straightLineReserve({
            replacementCost: a.replacementCost,
            ageYears: since === null ? null : wholeYears(since, today),
            lifeYears: life,
          }),
        };
      });
      return {
        period,
        spend: split(spend),
        byMonth: byMonth.map((r) => ({ month: r.month, amount: d(r.amount) })),
        byCategory: byCategory.map((r) => ({
          categoryKey: r.category_key,
          amount: d(r.amount),
        })),
        topAssets: top.map((r) => ({
          assetId: r.asset_id,
          code: r.code,
          amount: d(r.amount),
        })),
        capitalPlan: capitalPlan(rows, year),
        reserve: rows.reduce(
          (acc, r) =>
            r.reserve
              ? {
                  annual: acc.annual.plus(r.reserve.annual),
                  accrued: acc.accrued.plus(r.reserve.accrued),
                }
              : acc,
          { annual: ZERO, accrued: ZERO },
        ),
      };
    });
  }

  /** PM against corrective, MTTR, MTBF and schedule compliance over a period. */
  kpis(q: { from?: string; to?: string }): Promise<MaintenanceKpis> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today, timeZone } = await this.calendar.now(tx);
      const period = resolvePeriod(q, today);
      const completedIn = Prisma.sql`k.completed_at IS NOT NULL
        AND (k.completed_at AT TIME ZONE ${timeZone})::date
            BETWEEN ${period.from}::date AND ${period.to}::date`;
      const [work] = await tx.$queryRaw<
        { planned: bigint; corrective: bigint; mttr_seconds: number | null }[]
      >`
        SELECT count(*) FILTER (WHERE ${PLANNED}) AS planned,
               count(*) FILTER (WHERE NOT ${PLANNED}) AS corrective,
               (AVG(EXTRACT(EPOCH FROM (k.completed_at - k.created_at)))
                  FILTER (WHERE NOT ${PLANNED}))::float8 AS mttr_seconds
          FROM tickets k
         WHERE ${completedIn}`;
      const [fail] = await tx.$queryRaw<{ failures: bigint }[]>`
        SELECT count(*) AS failures FROM tickets k
         WHERE k.asset_id IS NOT NULL AND NOT ${PLANNED} AND k.cancelled_at IS NULL
           AND (k.created_at AT TIME ZONE ${timeZone})::date
               BETWEEN ${period.from}::date AND ${period.to}::date`;
      const inService = await tx.asset.count({
        where: { status: { not: 'retired' } },
      });
      const upTo: LocalDate = period.to < today ? period.to : today;
      const [plans] = await tx.$queryRaw<{ due: bigint; on_time: bigint }[]>`
        SELECT count(*) AS due,
               count(*) FILTER (WHERE status = 'done' AND on_time) AS on_time
          FROM maintenance_plan_occurrences
         WHERE status <> 'skipped'
           AND due_on BETWEEN ${period.from}::date AND ${upTo}::date`;
      const planned = Number(work.planned);
      const corrective = Number(work.corrective);
      const failures = Number(fail.failures);
      const due = upTo < period.from ? 0 : Number(plans.due);
      const onTime = upTo < period.from ? 0 : Number(plans.on_time);
      return {
        period,
        completedPlanned: planned,
        completedCorrective: corrective,
        plannedShare: ratio(planned, planned + corrective),
        mttrHours:
          work.mttr_seconds === null
            ? null
            : Math.round((work.mttr_seconds / 3600) * 100) / 100,
        failures,
        mtbfDays: failures
          ? Math.round(((inService * period.days) / failures) * 100) / 100
          : null,
        occurrencesDue: due,
        occurrencesOnTime: onTime,
        compliance: ratio(onTime, due),
      };
    });
  }
}

interface SpendRow {
  total: string | null;
  labour: string | null;
  contractor: string | null;
  parts: string | null;
  other: string | null;
  planned: string | null;
  corrective: string | null;
  last_year?: string | null;
}

const SPEND_COLUMNS = Prisma.sql`
  COALESCE(SUM(e.amount), 0)::text AS total,
  COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'labour'), 0)::text AS labour,
  COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'contractor'), 0)::text AS contractor,
  COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'part'), 0)::text AS parts,
  COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'other'), 0)::text AS other,
  COALESCE(SUM(e.amount) FILTER (WHERE ${PLANNED}), 0)::text AS planned,
  COALESCE(SUM(e.amount) FILTER (WHERE NOT ${PLANNED}), 0)::text AS corrective`;

function split(r: SpendRow): SpendSplit {
  return {
    total: d(r.total),
    labour: d(r.labour),
    contractor: d(r.contractor),
    parts: d(r.parts),
    other: d(r.other),
    planned: d(r.planned),
    corrective: d(r.corrective),
  };
}
