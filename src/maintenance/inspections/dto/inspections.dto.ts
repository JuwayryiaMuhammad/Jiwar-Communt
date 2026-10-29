import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate } from '../../schedules/local-dates';
import {
  RECURRENCE_EVERY,
  RECURRENCE_UNITS,
  type RecurrenceUnit,
} from '../../schedules/recurrence';
import {
  INSPECTION_STATUSES,
  ROUND_LEAD,
  ROUND_TITLE,
  type InspectionStatus,
} from '../inspection-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const BOOL = ['true', 'false'] as const;

class TargetDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'An active asset not in a unit.',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'An active common area.',
  })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;
}

export class CreateRoundDto extends TargetDto {
  @ApiProperty({
    type: String,
    minLength: ROUND_TITLE.min,
    maxLength: ROUND_TITLE.max,
  })
  @IsString()
  @Length(ROUND_TITLE.min, ROUND_TITLE.max, withParams(ROUND_TITLE))
  title: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active checklist for inspections.',
  })
  @IsUUID()
  checklistId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Holds inspections.perform.',
  })
  @IsUUID()
  assigneeId: string;

  @ApiProperty({
    type: Number,
    minimum: RECURRENCE_EVERY.min,
    maximum: RECURRENCE_EVERY.max,
  })
  @IsInt(withParams(RECURRENCE_EVERY))
  @Min(RECURRENCE_EVERY.min, withParams(RECURRENCE_EVERY))
  @Max(RECURRENCE_EVERY.max, withParams(RECURRENCE_EVERY))
  every: number;

  @ApiProperty({ enum: RECURRENCE_UNITS })
  @IsIn(RECURRENCE_UNITS, allowed(RECURRENCE_UNITS))
  unit: RecurrenceUnit;

  @ApiProperty({ type: String, format: 'date' })
  @IsString()
  @IsLocalDate()
  anchorOn: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: ROUND_LEAD.min,
    maximum: ROUND_LEAD.max,
    default: 2,
  })
  @IsOptional()
  @IsInt(withParams(ROUND_LEAD))
  @Min(ROUND_LEAD.min, withParams(ROUND_LEAD))
  @Max(ROUND_LEAD.max, withParams(ROUND_LEAD))
  leadDays?: number;
}

export class UpdateRoundDto {
  @ApiPropertyOptional({
    type: String,
    minLength: ROUND_TITLE.min,
    maxLength: ROUND_TITLE.max,
  })
  @IsOptional()
  @IsString()
  @Length(ROUND_TITLE.min, ROUND_TITLE.max, withParams(ROUND_TITLE))
  title?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  checklistId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: RECURRENCE_EVERY.min,
    maximum: RECURRENCE_EVERY.max,
  })
  @IsOptional()
  @IsInt(withParams(RECURRENCE_EVERY))
  @Min(RECURRENCE_EVERY.min, withParams(RECURRENCE_EVERY))
  @Max(RECURRENCE_EVERY.max, withParams(RECURRENCE_EVERY))
  every?: number;

  @ApiPropertyOptional({ enum: RECURRENCE_UNITS })
  @IsOptional()
  @IsIn(RECURRENCE_UNITS, allowed(RECURRENCE_UNITS))
  unit?: RecurrenceUnit;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  anchorOn?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: ROUND_LEAD.min,
    maximum: ROUND_LEAD.max,
  })
  @IsOptional()
  @IsInt(withParams(ROUND_LEAD))
  @Min(ROUND_LEAD.min, withParams(ROUND_LEAD))
  @Max(ROUND_LEAD.max, withParams(ROUND_LEAD))
  leadDays?: number;
}

export class CreateInspectionDto extends TargetDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  checklistId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Holds inspections.perform.',
  })
  @IsUUID()
  assigneeId: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Today or later, the compound’s day.',
  })
  @IsString()
  @IsLocalDate()
  dueOn: string;
}

export class StartInspectionDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 200,
    description:
      'The scanned tag of the target (`JWA1.…` or `JWL1.…`); required by a checklist that asks.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  code?: string;
}

export class InspectionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: INSPECTION_STATUSES })
  @IsOptional()
  @IsIn(INSPECTION_STATUSES, allowed(INSPECTION_STATUSES))
  status?: InspectionStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  roundId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;
}

export class MyInspectionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: INSPECTION_STATUSES })
  @IsOptional()
  @IsIn(INSPECTION_STATUSES, allowed(INSPECTION_STATUSES))
  status?: InspectionStatus;
}

export class RoundsQueryDto {
  @ApiPropertyOptional({ enum: BOOL })
  @IsOptional()
  @IsIn(BOOL, allowed(BOOL))
  active?: (typeof BOOL)[number];
}

export class InspectionReportQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Due on or after, the compound’s day.',
  })
  @IsString()
  @IsLocalDate()
  from: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Due on or before; at most 366 days after `from`.',
  })
  @IsString()
  @IsLocalDate()
  to: string;
}
