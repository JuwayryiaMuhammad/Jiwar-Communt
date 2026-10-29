import { ApiProperty } from '@nestjs/swagger';
import type { Meter, MeterAlert, MeterReading } from '@prisma/client';
import { REASON_CODES } from '../../../core/common/reasons';
import { ofDateColumn, ofDateColumnOrNull } from '../../schedules/local-dates';
import type { EnergySettingsView as EnergySettings } from '../energy-settings.service';
import {
  METER_KINDS,
  METER_MODES,
  METER_UNITS,
  type MeterKind,
} from '../meter-rules';
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
