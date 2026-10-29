import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';
import { REASON_CODES } from '../../../core/common/reasons';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  OUTAGE_MAX_BUILDINGS,
  OUTAGE_SCOPES,
  type OutageScope,
} from '../outage-rules';

const KINDS = REASON_CODES.outageKind;
const BUILDINGS = { max: OUTAGE_MAX_BUILDINGS };
const BUILDING = { min: 1, max: 100 };
const NOTE = { min: 1, max: 500 };

export class CreateOutageDto {
  @ApiProperty({ enum: KINDS, enumName: 'OutageKind' })
  @IsIn(KINDS, withParams({ allowed: [...KINDS] }))
  kind: string;

  @ApiProperty({
    type: Boolean,
    description:
      'Planned: its residents are told 48 hours before it starts (at once when it starts sooner); not planned: at once.',
  })
  @IsBoolean()
  planned: boolean;

  @ApiProperty({
    enum: OUTAGE_SCOPES,
    enumName: 'OutageScope',
    description: '`compound`: no building named; `buildings`: 1 to 50 named.',
  })
  @IsIn(OUTAGE_SCOPES, withParams({ allowed: [...OUTAGE_SCOPES] }))
  scope: OutageScope;

  @ApiPropertyOptional({
    type: [String],
    maxItems: BUILDINGS.max,
    description:
      'Buildings, as their units name them: with `buildings`, and only then.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BUILDINGS.max, withParams(BUILDINGS))
  @IsString({ each: true })
  @Length(BUILDING.min, BUILDING.max, { each: true, ...withParams(BUILDING) })
  buildings?: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'With its offset; a year ahead at most.',
  })
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'With its offset; after the start, two weeks at most.',
  })
  @ToInstant()
  @IsDate()
  endsAt: Date;

  @ApiPropertyOptional({
    type: String,
    maxLength: NOTE.max,
    description: 'What the residents are asked to do (store water, …).',
  })
  @IsOptional()
  @IsString()
  @Length(NOTE.min, NOTE.max, withParams(NOTE))
  note?: string;
}

export class UpdateOutageDto {
  @ApiPropertyOptional({ enum: OUTAGE_SCOPES, enumName: 'OutageScope' })
  @IsOptional()
  @IsIn(OUTAGE_SCOPES, withParams({ allowed: [...OUTAGE_SCOPES] }))
  scope?: OutageScope;

  @ApiPropertyOptional({ type: [String], maxItems: BUILDINGS.max })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BUILDINGS.max, withParams(BUILDINGS))
  @IsString({ each: true })
  @Length(BUILDING.min, BUILDING.max, { each: true, ...withParams(BUILDING) })
  buildings?: string[];

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Only before it starts; told anew once.',
  })
  @IsOptional()
  @ToInstant()
  @IsDate()
  startsAt?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @ToInstant()
  @IsDate()
  endsAt?: Date;

  @ApiPropertyOptional({ type: String, maxLength: NOTE.max, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(NOTE.min, NOTE.max, withParams(NOTE))
  note?: string | null;
}
