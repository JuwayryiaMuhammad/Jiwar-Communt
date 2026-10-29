import { ApiProperty } from '@nestjs/swagger';
import type {
  EnergyMeasure,
  EnergyTariff,
  Meter,
  MeterAlert,
  MeterReading,
  MeterReadingImport,
} from '@prisma/client';
import { REASON_CODES } from '../../../core/common/reasons';
import { PeriodView } from '../../economics/views/economics.views';
import { ofDateColumn, ofDateColumnOrNull } from '../../schedules/local-dates';
import type {
  ConsumptionGroupRead,
  ConsumptionReport,
  UsePart,
} from '../consumption.service';
import { CONSUMPTION_GROUPS } from '../consumption-rules';
import type { EnergySettingsView as EnergySettings } from '../energy-settings.service';
import type { MeasureEffect } from '../measures.service';
import {
  METER_KINDS,
  METER_MODES,
  METER_UNITS,
  type MeterKind,
} from '../meter-rules';
import type { ReadingProblem } from '../reading-import-rules';
import { ALERT_KINDS, READING_SOURCES, reading } from '../reading-rules';
import type { MeterToRead } from '../readings.service';

export class MeterView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  kind: string;
  @ApiProperty({ type: String, description: 'kWh, m³, L or h.' })
  unit: string;
  @ApiProperty({ enum: METER_MODES, enumName: 'MeterMode' })
  mode: string;
  @ApiProperty({ type: String, description: 'Four decimals.' })
  multiplier: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  commonAreaId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetId: string | null;
  @ApiProperty({ type: String, nullable: true })
  serial: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  installedOn: string | null;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.meterRetire,
    enumName: 'MeterRetireReason',
    nullable: true,
  })
  retireReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(m: Meter): MeterView {
    return {
      id: m.id,
      code: m.code,
      kind: m.kind,
      unit: METER_UNITS[m.kind as MeterKind],
      mode: m.mode,
      multiplier: m.multiplier.toFixed(4),
      unitId: m.unitId,
      commonAreaId: m.commonAreaId,
      assetId: m.assetId,
      serial: m.serial,
      installedOn: ofDateColumnOrNull(m.installedOn),
      active: m.active,
      retiredAt: m.retiredAt,
      retireReason: m.retireReason,
      createdAt: m.createdAt,
    };
  }
}

export class MeterReadingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  meterId: string;
  @ApiProperty({ type: String, format: 'date' })
  readOn: string;
  @ApiProperty({
    type: String,
    description: 'Four decimals, before the multiplier.',
  })
  value: string;
  @ApiProperty({ type: Boolean })
  reset: boolean;
  @ApiProperty({ enum: READING_SOURCES, enumName: 'MeterReadingSource' })
  source: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The reading this one corrects.',
  })
  supersedesId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Corrected or withdrawn then.',
  })
  supersededAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.readingCorrect,
    enumName: 'ReadingCorrectReason',
    nullable: true,
  })
  supersededReason: string | null;

  static from(r: MeterReading): MeterReadingView {
    return {
      id: r.id,
      meterId: r.meterId,
      readOn: ofDateColumn(r.readOn),
      value: reading(r.value),
      reset: r.reset,
      source: r.source,
      supersedesId: r.supersedesId,
      recordedAt: r.recordedAt,
      supersededAt: r.supersededAt,
      supersededReason: r.supersededReason,
    };
  }
}

export class MeterAlertView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  meterId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  readingId: string;
  @ApiProperty({ type: String, format: 'date' })
  readOn: string;
  @ApiProperty({ enum: ALERT_KINDS, enumName: 'MeterAlertKind' })
  kind: string;
  @ApiProperty({
    type: String,
    description: 'The period’s use a day, in the kind’s unit.',
  })
  dailyRate: string;
  @ApiProperty({
    type: String,
    description: 'The mean of the periods before, a day.',
  })
  baselineRate: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acknowledgedAt: Date | null;

  static from(a: MeterAlert): MeterAlertView {
    return {
      id: a.id,
      meterId: a.meterId,
      readingId: a.readingId,
      readOn: ofDateColumn(a.readOn),
      kind: a.kind,
      dailyRate: reading(a.dailyRate),
      baselineRate: reading(a.baselineRate),
      createdAt: a.createdAt,
      acknowledgedAt: a.acknowledgedAt,
    };
  }
}

class LastReadingView {
  @ApiProperty({ type: String, format: 'date' })
  readOn: string;
  @ApiProperty({ type: String })
  value: string;
}

class ExpectedRangeView {
  @ApiProperty({ type: String })
  from: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null until the meter has a few periods behind it.',
  })
  to: string | null;
}

/** A meter as the technician who reads it sees it (ADR 0066): no history, no use. */
export class MeterToReadView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  kind: string;
  @ApiProperty({ type: String })
  unit: string;
  @ApiProperty({ enum: METER_MODES, enumName: 'MeterMode' })
  mode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The unit it is in.',
  })
  unitCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The common area it is in.',
  })
  areaCode: string | null;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: LastReadingView, nullable: true })
  last: LastReadingView | null;
  @ApiProperty({
    type: ExpectedRangeView,
    nullable: true,
    description:
      'Where today’s reading is expected, in the register’s figures.',
  })
  expected: ExpectedRangeView | null;

  static from(t: MeterToRead): MeterToReadView {
    return {
      id: t.meter.id,
      code: t.meter.code,
      kind: t.meter.kind,
      unit: METER_UNITS[t.meter.kind as MeterKind],
      mode: t.meter.mode,
      unitCode: t.unitCode,
      areaCode: t.areaCode,
      active: t.meter.active,
      last: t.last && { readOn: t.last.readOn, value: reading(t.last.value) },
      expected: t.expected,
    };
  }
}

export class EnergySettingsView {
  @ApiProperty({ type: String, description: 'Two decimals, 1.2 to 10.' })
  anomalyFactor: string;
  @ApiProperty({ type: Number })
  anomalyPeriods: number;

  static from(s: EnergySettings): EnergySettingsView {
    return { ...s };
  }
}

class ReadingImportProblemView {
  @ApiProperty({
    type: Number,
    description: 'The sheet’s line, the header being 1.',
  })
  line: number;
  @ApiProperty({ type: String, description: 'The column.' })
  field: string;
  @ApiProperty({ type: String })
  code: string;
}

export class MeterReadingImportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ['valid', 'invalid', 'applied'] })
  status: 'valid' | 'invalid' | 'applied';
  @ApiProperty({ type: Number })
  rowCount: number;
  @ApiProperty({ type: Number })
  errorCount: number;
  @ApiProperty({
    type: [ReadingImportProblemView],
    description: 'The first 100 problems, in sheet order. Never a cell’s text.',
  })
  errors: ReadingImportProblemView[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Readings written, once applied.',
  })
  appliedCount: number | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appliedAt: Date | null;

  static from(i: MeterReadingImport): MeterReadingImportView {
    return {
      id: i.id,
      status: i.status as MeterReadingImportView['status'],
      rowCount: i.rowCount,
      errorCount: i.errorCount,
      errors: i.errors as unknown as ReadingProblem[],
      appliedCount: i.appliedCount,
      createdAt: i.createdAt,
      appliedAt: i.appliedAt,
    };
  }
}

export class TariffView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  kind: string;
  @ApiProperty({ type: String, format: 'date' })
  effectiveOn: string;
  @ApiProperty({ type: String, description: 'EGP a unit, four decimals.' })
  pricePerUnit: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(t: EnergyTariff): TariffView {
    return {
      id: t.id,
      kind: t.kind,
      effectiveOn: ofDateColumn(t.effectiveOn),
      pricePerUnit: t.pricePerUnit.toFixed(4),
      createdAt: t.createdAt,
    };
  }
}

class UsePartView {
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
    description: 'EGP at the tariffs in force; null where none was.',
  })
  cost: string | null;

  static from(p: UsePart): UsePartView {
    return { ...p };
  }
}

class ConsumptionGroupView {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The meter’s id, the building’s name or the common area’s id; null: none.',
  })
  key: string | null;
  @ApiProperty({ type: String, nullable: true })
  label: string | null;
  @ApiProperty({ type: Number })
  meters: number;
  @ApiProperty({ type: String })
  use: string;
  @ApiProperty({ type: String, nullable: true })
  cost: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Use a square metre of the units’ floor area.',
  })
  perSqm: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Use an occupied unit: to compare buildings by.',
  })
  perOccupiedUnit: string | null;
  @ApiProperty({ type: [UsePartView] })
  months: UsePartView[];

  static from(g: ConsumptionGroupRead): ConsumptionGroupView {
    return { ...g, months: g.months.map((m) => UsePartView.from(m)) };
  }
}

export class ConsumptionView {
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  kind: string;
  @ApiProperty({ type: String })
  unit: string;
  @ApiProperty({ enum: CONSUMPTION_GROUPS, enumName: 'ConsumptionGroup' })
  groupBy: string;
  @ApiProperty({ type: PeriodView })
  period: PeriodView;
  @ApiProperty({ type: String })
  use: string;
  @ApiProperty({ type: String, nullable: true })
  cost: string | null;
  @ApiProperty({ type: [ConsumptionGroupView] })
  groups: ConsumptionGroupView[];

  static from(r: ConsumptionReport): ConsumptionView {
    return {
      kind: r.kind,
      unit: r.unit,
      groupBy: r.groupBy,
      period: PeriodView.from(r.period),
      use: r.use,
      cost: r.cost,
      groups: r.groups.map((g) => ConsumptionGroupView.from(g)),
    };
  }
}

class EffectSideView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: String, description: 'Use a day, four decimals.' })
  perDay: string;
}

class MeasureEffectView {
  @ApiProperty({ type: Number })
  weeks: number;
  @ApiProperty({ type: EffectSideView })
  before: EffectSideView;
  @ApiProperty({ type: EffectSideView, nullable: true })
  after: EffectSideView | null;
  @ApiProperty({
    type: Boolean,
    description: 'The after side has all its days.',
  })
  complete: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '(after − before) / before a day, %; one decimal.',
  })
  changePct: string | null;

  static from(e: MeasureEffect): MeasureEffectView {
    return { ...e };
  }
}

export class MeasureView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  kind: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  meterId: string | null;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  endedOn: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  cost: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(m: EnergyMeasure): MeasureView {
    return {
      id: m.id,
      title: m.title,
      kind: m.kind,
      meterId: m.meterId,
      building: m.building,
      startsOn: ofDateColumn(m.startsOn),
      endedOn: ofDateColumnOrNull(m.endedOn),
      cost: m.cost?.toFixed(2) ?? null,
      createdAt: m.createdAt,
    };
  }
}

export class MeasureCardView extends MeasureView {
  @ApiProperty({ type: MeasureEffectView })
  effect: MeasureEffectView;

  static card(r: {
    measure: EnergyMeasure;
    effect: MeasureEffect;
  }): MeasureCardView {
    return {
      ...MeasureView.from(r.measure),
      effect: MeasureEffectView.from(r.effect),
    };
  }
}
