import { ApiProperty } from '@nestjs/swagger';
import { PeriodView } from '../../economics/views/economics.views';
import type {
  ConsumptionBenchmark,
  HouseholdConsumption,
  HouseholdKindRead,
  HouseholdMonthRead,
} from '../household-consumption.service';
import { METER_KINDS } from '../meter-rules';

class HouseholdMonthView {
  @ApiProperty({ type: String, description: 'YYYY-MM.' })
  month: string;
  @ApiProperty({
    type: String,
    description: 'In the kind’s unit, four decimals.',
  })
  use: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'EGP at the compound’s tariffs: an estimate, never a bill; null where none was in force.',
  })
  estimatedCost: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'Every day of the month is read, all of it in the household’s time: only complete months are compared.',
  })
  complete: boolean;

  static from(m: HouseholdMonthRead): HouseholdMonthView {
    return { ...m };
  }
}

class MonthUseView {
  @ApiProperty({ type: String, description: 'YYYY-MM.' })
  month: string;
  @ApiProperty({ type: String })
  use: string;
}

class HouseholdCompareView {
  @ApiProperty({ type: String, description: 'The latest complete month.' })
  month: string;
  @ApiProperty({ type: String })
  use: string;
  @ApiProperty({
    type: MonthUseView,
    nullable: true,
    description: 'The month before, when complete and in the household’s time.',
  })
  previousMonth: MonthUseView | null;
  @ApiProperty({
    type: MonthUseView,
    nullable: true,
    description:
      'The same month a year before, when complete and in the household’s time.',
  })
  sameMonthLastYear: MonthUseView | null;
}

class HouseholdKindView {
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  kind: string;
  @ApiProperty({ type: String })
  unit: string;
  @ApiProperty({ type: Number })
  meters: number;
  @ApiProperty({ type: String })
  use: string;
  @ApiProperty({ type: String, nullable: true })
  estimatedCost: string | null;
  @ApiProperty({ type: [HouseholdMonthView] })
  months: HouseholdMonthView[];
  @ApiProperty({ type: HouseholdCompareView, nullable: true })
  compare: HouseholdCompareView | null;

  static from(k: HouseholdKindRead): HouseholdKindView {
    return {
      ...k,
      months: k.months.map((m) => HouseholdMonthView.from(m)),
    };
  }
}

/**
 * A household's own consumption (ADR 0069): its unit's meters over its
 * own tenure, by kind and month — nothing of a household before it.
 */
export class HouseholdConsumptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'The household’s first day there: nothing before it is read.',
  })
  since: string;
  @ApiProperty({ type: PeriodView })
  period: PeriodView;
  @ApiProperty({ type: [HouseholdKindView] })
  kinds: HouseholdKindView[];

  static from(c: HouseholdConsumption): HouseholdConsumptionView {
    return {
      unitId: c.unitId,
      since: c.since,
      period: PeriodView.from(c.period),
      kinds: c.kinds.map((k) => HouseholdKindView.from(k)),
    };
  }
}

/**
 * A household's month against other homes of its building (ADR 0069):
 * never a figure of fewer than five other units, never which units.
 */
export class ConsumptionBenchmarkView {
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  kind: string;
  @ApiProperty({ type: String })
  unit: string;
  @ApiProperty({ type: String, description: 'YYYY-MM.' })
  month: string;
  @ApiProperty({ type: Boolean })
  available: boolean;
  @ApiProperty({
    enum: ['TOO_FEW_UNITS', 'NO_BUILDING'],
    nullable: true,
    description:
      'Why there is none: fewer than five other homes of the building were read all month, or the unit is in no building.',
  })
  reason: string | null;
  @ApiProperty({ type: Number, nullable: true })
  units: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Use a square metre a day, the other homes’ median.',
  })
  medianPerSqmDay: string | null;
  @ApiProperty({ type: String, nullable: true })
  meanPerSqmDay: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The household’s own, when it lived there all month, its meters read it all and its unit has a floor area.',
  })
  mine: string | null;

  static from(b: ConsumptionBenchmark): ConsumptionBenchmarkView {
    return { ...b };
  }
}
