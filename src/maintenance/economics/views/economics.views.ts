import { ApiProperty } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { ADVICE_REASONS, REPLACEMENT_ADVICE } from '../economics-rules';
import type {
  AssetEconomics,
  CompoundEconomics,
  MaintenanceKpis,
  SpendSplit,
} from '../economics.service';
import type { Period } from '../period';

const egp = (v: Prisma.Decimal) => v.toFixed(2);
const egpOrNull = (v: Prisma.Decimal | null) => (v === null ? null : egp(v));
const two = (n: number | null) =>
  n === null ? null : Math.round(n * 100) / 100;

class SpendSplitView {
  @ApiProperty({ type: String, description: 'EGP, voided entries left out.' })
  total: string;
  @ApiProperty({ type: String })
  labour: string;
  @ApiProperty({ type: String })
  contractor: string;
  @ApiProperty({ type: String, description: 'Net of parts returned.' })
  parts: string;
  @ApiProperty({ type: String })
  other: string;
  @ApiProperty({
    type: String,
    description: 'A plan’s work orders and residents’ check-ups.',
  })
  planned: string;
  @ApiProperty({ type: String, description: 'Repairs: everything else.' })
  corrective: string;

  static from(s: SpendSplit): SpendSplitView {
    return {
      total: egp(s.total),
      labour: egp(s.labour),
      contractor: egp(s.contractor),
      parts: egp(s.parts),
      other: egp(s.other),
      planned: egp(s.planned),
      corrective: egp(s.corrective),
    };
  }
}

class ReserveView {
  @ApiProperty({ type: String, description: 'EGP to set aside a year.' })
  annual: string;
  @ApiProperty({ type: String, description: 'EGP built up by now.' })
  accrued: string;
}

class PeriodView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: Number })
  days: number;

  static from(p: Period): PeriodView {
    return { from: p.from, to: p.to, days: p.days };
  }
}

/** One asset's economics (ADR 0065): rules on its tickets' costs. */
export class AssetEconomicsView {
  @ApiProperty({ type: String, format: 'uuid' })
  assetId: string;
  @ApiProperty({ type: SpendSplitView, description: 'Everything, ever.' })
  cumulative: SpendSplitView;
  @ApiProperty({ type: String, description: 'EGP, the last twelve months.' })
  lastYear: string;
  @ApiProperty({
    type: Number,
    description: 'Corrective tickets, ever, not cancelled.',
  })
  failures: number;
  @ApiProperty({ type: Number, description: 'Days they stood open, together.' })
  downtimeDays: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP: downtime days × its cost of a day; null without one.',
  })
  downtimeCost: string | null;
  @ApiProperty({ type: Number, nullable: true })
  mtbfDays: number | null;
  @ApiProperty({ type: Number, nullable: true })
  ageYears: number | null;
  @ApiProperty({ type: Number, nullable: true })
  lifeYears: number | null;
  @ApiProperty({ type: String, nullable: true })
  replacementCost: string | null;
  @ApiProperty({ type: Number, nullable: true })
  replacementYear: number | null;
  @ApiProperty({ enum: REPLACEMENT_ADVICE, enumName: 'ReplacementAdvice' })
  advice: string;
  @ApiProperty({
    enum: ADVICE_REASONS,
    enumName: 'ReplacementAdviceReason',
    isArray: true,
  })
  reasons: string[];
  @ApiProperty({ type: ReserveView, nullable: true })
  reserve: ReserveView | null;

  static from(e: AssetEconomics): AssetEconomicsView {
    return {
      assetId: e.assetId,
      cumulative: SpendSplitView.from(e.cumulative),
      lastYear: egp(e.lastYear),
      failures: e.failures,
      downtimeDays: two(e.downtimeDays)!,
      downtimeCost: egpOrNull(e.downtimeCost),
      mtbfDays: two(e.mtbfDays),
      ageYears: e.ageYears,
      lifeYears: e.lifeYears,
      replacementCost: egpOrNull(e.replacementCost),
      replacementYear: e.replacementYear,
      advice: e.advice,
      reasons: e.reasons,
      reserve: e.reserve && {
        annual: egp(e.reserve.annual),
        accrued: egp(e.reserve.accrued),
      },
    };
  }
}

class MonthSpendView {
  @ApiProperty({ type: String, example: '2026-10' })
  month: string;
  @ApiProperty({ type: String })
  amount: string;
}

class CategorySpendView {
  @ApiProperty({ type: String })
  categoryKey: string;
  @ApiProperty({ type: String })
  amount: string;
}

class AssetSpendView {
  @ApiProperty({ type: String, format: 'uuid' })
  assetId: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  amount: string;
}

class CapitalYearView {
  @ApiProperty({ type: Number })
  year: number;
  @ApiProperty({ type: String, description: 'EGP of replacements due.' })
  amount: string;
  @ApiProperty({ type: Number })
  assets: number;
}

/** The compound's maintenance spend over a period, and the plan ahead. */
export class CompoundEconomicsView {
  @ApiProperty({ type: PeriodView })
  period: PeriodView;
  @ApiProperty({ type: SpendSplitView })
  spend: SpendSplitView;
  @ApiProperty({
    type: [MonthSpendView],
    description: 'The compound’s months.',
  })
  byMonth: MonthSpendView[];
  @ApiProperty({ type: [CategorySpendView] })
  byCategory: CategorySpendView[];
  @ApiProperty({
    type: [AssetSpendView],
    description: 'The ten that cost most.',
  })
  topAssets: AssetSpendView[];
  @ApiProperty({
    type: [CapitalYearView],
    description:
      'Five years from this one; an overdue replacement in the first.',
  })
  capitalPlan: CapitalYearView[];
  @ApiProperty({
    type: ReserveView,
    description: 'Straight-line, every asset with a cost and a life.',
  })
  reserve: ReserveView;

  static from(e: CompoundEconomics): CompoundEconomicsView {
    return {
      period: PeriodView.from(e.period),
      spend: SpendSplitView.from(e.spend),
      byMonth: e.byMonth.map((m) => ({
        month: m.month,
        amount: egp(m.amount),
      })),
      byCategory: e.byCategory.map((c) => ({
        categoryKey: c.categoryKey,
        amount: egp(c.amount),
      })),
      topAssets: e.topAssets.map((a) => ({
        assetId: a.assetId,
        code: a.code,
        amount: egp(a.amount),
      })),
      capitalPlan: e.capitalPlan.map((y) => ({
        year: y.year,
        amount: egp(y.amount),
        assets: y.assets,
      })),
      reserve: {
        annual: egp(e.reserve.annual),
        accrued: egp(e.reserve.accrued),
      },
    };
  }
}

/** The maintenance KPIs over a period (ADR 0065). */
export class MaintenanceKpisView {
  @ApiProperty({ type: PeriodView })
  period: PeriodView;
  @ApiProperty({ type: Number })
  completedPlanned: number;
  @ApiProperty({ type: Number })
  completedCorrective: number;
  @ApiProperty({ type: Number, nullable: true, description: '0–1.' })
  plannedShare: number | null;
  @ApiProperty({ type: Number, nullable: true })
  mttrHours: number | null;
  @ApiProperty({ type: Number })
  failures: number;
  @ApiProperty({ type: Number, nullable: true })
  mtbfDays: number | null;
  @ApiProperty({ type: Number })
  occurrencesDue: number;
  @ApiProperty({ type: Number })
  occurrencesOnTime: number;
  @ApiProperty({ type: Number, nullable: true, description: '0–1.' })
  compliance: number | null;

  static from(k: MaintenanceKpis): MaintenanceKpisView {
    return { ...k, period: PeriodView.from(k.period) };
  }
}
