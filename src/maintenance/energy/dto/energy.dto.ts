import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
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
