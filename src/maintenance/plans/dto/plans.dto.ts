import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketPriority } from '@prisma/client';
import {
  IsEnum,
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
import { METRIC_KEY } from '../../checklists/checklist-rules';
import { LOCAL_DATE } from '../../schedules/local-dates';
import {
  RECURRENCE_EVERY,
  RECURRENCE_UNITS,
  type RecurrenceUnit,
} from '../../schedules/recurrence';
import {
  PLAN_BASES,
  PLAN_DAYS,
  PLAN_TITLE,
  PLAN_TRIGGERS,
  type PlanBasis,
  type PlanTrigger,
} from '../plan-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const INTERVAL = /^(?!0+(\.0{1,4})?$)\d{1,10}(\.\d{1,4})?$/;
const BOOL = ['true', 'false'] as const;

class PlanTimingDto {
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

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'The series’ first date, the compound’s day; a month’s step keeps its day (clamped).',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  anchorOn?: string;

  @ApiPropertyOptional({
    enum: PLAN_BASES,
    description:
      '`fixed`: on the series’ own dates; `floating`: one interval after the last was done.',
  })
  @IsOptional()
  @IsIn(PLAN_BASES, allowed(PLAN_BASES))
  basis?: PlanBasis;

  @ApiPropertyOptional({
    type: String,
    pattern: INTERVAL.source,
    description: 'A usage plan’s interval (e.g. 500 run hours).',
  })
  @IsOptional()
  @IsString()
  @Matches(INTERVAL)
  usageInterval?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: PLAN_DAYS.min,
    maximum: PLAN_DAYS.max,
    default: 7,
    description: 'Days before the due date its work order opens.',
  })
  @IsOptional()
  @IsInt(withParams(PLAN_DAYS))
  @Min(PLAN_DAYS.min, withParams(PLAN_DAYS))
  @Max(PLAN_DAYS.max, withParams(PLAN_DAYS))
  leadDays?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: PLAN_DAYS.min,
    maximum: PLAN_DAYS.max,
    default: 3,
    description: 'Days after it that still count as on time.',
  })
  @IsOptional()
  @IsInt(withParams(PLAN_DAYS))
  @Min(PLAN_DAYS.min, withParams(PLAN_DAYS))
  @Max(PLAN_DAYS.max, withParams(PLAN_DAYS))
  graceDays?: number;

  @ApiPropertyOptional({
    enum: TicketPriority,
    enumName: 'TicketPriority',
    default: 'normal',
  })
  @IsOptional()
  @IsEnum(TicketPriority, allowed(Object.values(TicketPriority)))
  priority?: TicketPriority;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'An active category; the asset type’s by default.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'Answers for its work orders (their reporter): an active dispatcher. The caller by default.',
  })
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

export class CreatePlanDto extends PlanTimingDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active asset not in a unit.',
  })
  @IsUUID()
  assetId: string;

  @ApiProperty({
    type: String,
    minLength: PLAN_TITLE.min,
    maxLength: PLAN_TITLE.max,
    description: 'What is done: its work orders’ words.',
  })
  @IsString()
  @Length(PLAN_TITLE.min, PLAN_TITLE.max, withParams(PLAN_TITLE))
  title: string;

  @ApiProperty({ enum: PLAN_TRIGGERS })
  @IsIn(PLAN_TRIGGERS, allowed(PLAN_TRIGGERS))
  trigger: PlanTrigger;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'An active checklist for planned jobs.',
  })
  @IsOptional()
  @IsUUID()
  checklistId?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: METRIC_KEY.source,
    description: 'A usage plan’s metric.',
  })
  @IsOptional()
  @IsString()
  @Matches(METRIC_KEY)
  metricKey?: string;
}

export class UpdatePlanDto extends PlanTimingDto {
  @ApiPropertyOptional({
    type: String,
    minLength: PLAN_TITLE.min,
    maxLength: PLAN_TITLE.max,
  })
  @IsOptional()
  @IsString()
  @Length(PLAN_TITLE.min, PLAN_TITLE.max, withParams(PLAN_TITLE))
  title?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null: no checklist.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  checklistId?: string | null;
}

export class DeferPlanDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'From today, within a year.',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  toDate: string;

  @ApiProperty({ type: String, description: 'From `planDefer`.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class PlansQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ enum: BOOL })
  @IsOptional()
  @IsIn(BOOL, allowed(BOOL))
  active?: (typeof BOOL)[number];
}
