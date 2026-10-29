import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate } from '../../schedules/local-dates';
import {
  METER_CODE,
  METER_KINDS,
  METER_MODES,
  METER_SERIAL,
  MULTIPLIER,
  type MeterKind,
  type MeterMode,
} from '../meter-rules';
import { ANOMALY_PERIODS } from '../energy-settings.service';
import { READING_VALUE } from '../reading-rules';

const BOOL = ['true', 'false'] as const;
const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });

export class CreateMeterDto {
  @ApiProperty({
    type: String,
    pattern: METER_CODE.source,
    description: 'The compound’s short code, unique. Never changes.',
  })
  @IsString()
  @Matches(METER_CODE)
  code: string;

  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  @IsIn(METER_KINDS, allowed(METER_KINDS))
  kind: MeterKind;

  @ApiPropertyOptional({
    enum: METER_MODES,
    enumName: 'MeterMode',
    default: 'cumulative',
    description:
      '`cumulative`: the register as it stands; `interval`: what was used since the last reading. Never changes.',
  })
  @IsOptional()
  @IsIn(METER_MODES, allowed(METER_MODES))
  mode?: MeterMode;

  @ApiPropertyOptional({
    type: String,
    pattern: MULTIPLIER.source,
    default: '1',
    description:
      'What one step of the register is worth, more than 0. Never changes.',
  })
  @IsOptional()
  @IsString()
  @Matches(MULTIPLIER)
  multiplier?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'In this unit. Exactly one of unitId, commonAreaId, assetId.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'In this common area.',
  })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'On this asset (a generator’s hours), where it stands.',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ type: String, maxLength: METER_SERIAL.max })
  @IsOptional()
  @IsString()
  @Length(METER_SERIAL.min, METER_SERIAL.max, withParams(METER_SERIAL))
  serial?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description: 'The compound’s day it was installed; not after today.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  installedOn?: string;
}

export class UpdateMeterDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: METER_SERIAL.max,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(METER_SERIAL.min, METER_SERIAL.max, withParams(METER_SERIAL))
  serial?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @IsLocalDate()
  installedOn?: string | null;
}

export class MetersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: METER_KINDS, enumName: 'MeterKind' })
  @IsOptional()
  @IsIn(METER_KINDS, allowed(METER_KINDS))
  kind?: MeterKind;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;

  @ApiPropertyOptional({ enum: BOOL })
  @IsOptional()
  @IsIn(BOOL, allowed(BOOL))
  active?: (typeof BOOL)[number];
}

export class RecordReadingDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description:
      'The compound’s day it was read: by today, at most 400 days back.',
  })
  @IsString()
  @IsLocalDate()
  readOn: string;

  @ApiProperty({
    type: String,
    pattern: READING_VALUE.source,
    description:
      'The register as it stands (cumulative) or the use since the last reading (interval), before the multiplier.',
  })
  @IsString()
  @Matches(READING_VALUE)
  value: string;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'The register started again from zero (replaced or rolled over).',
  })
  @IsOptional()
  @IsBoolean()
  reset?: boolean;
}

export class CorrectReadingDto {
  @ApiProperty({ type: String, pattern: READING_VALUE.source })
  @IsString()
  @Matches(READING_VALUE)
  value: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description: 'Another day, if the day was wrong.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  readOn?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  reset?: boolean;

  @ApiProperty({ type: String, description: 'From `readingCorrect`.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class ReadingsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: BOOL,
    description: '`true` lists the corrected and withdrawn ones too.',
  })
  @IsOptional()
  @IsIn(BOOL, allowed(BOOL))
  superseded?: (typeof BOOL)[number];
}

export class MeterAlertsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  meterId?: string;

  @ApiPropertyOptional({
    enum: BOOL,
    description: '`true`: not acknowledged yet.',
  })
  @IsOptional()
  @IsIn(BOOL, allowed(BOOL))
  open?: (typeof BOOL)[number];
}

/** A factor with up to two decimals. */
const FACTOR = /^\d{1,2}(\.\d{1,2})?$/;

export class EnergySettingsDto {
  @ApiPropertyOptional({
    type: String,
    pattern: FACTOR.source,
    description:
      'From 1.2 to 10: a spike is the daily use above the mean times this.',
  })
  @IsOptional()
  @IsString()
  @Matches(FACTOR)
  anomalyFactor?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: ANOMALY_PERIODS.min,
    maximum: ANOMALY_PERIODS.max,
    description: 'How many earlier periods make the mean.',
  })
  @IsOptional()
  @IsInt(withParams({ ...ANOMALY_PERIODS }))
  @Min(ANOMALY_PERIODS.min, withParams({ ...ANOMALY_PERIODS }))
  @Max(ANOMALY_PERIODS.max, withParams({ ...ANOMALY_PERIODS }))
  anomalyPeriods?: number;
}
