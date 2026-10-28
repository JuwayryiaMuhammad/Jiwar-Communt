import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ToInstant } from '../../../core/common/validation/instant';

const KINDS = ['closed_unit_inspection', 'custom'] as const;
const STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;

export class CreateGuardTaskDto {
  @ApiProperty({ enum: KINDS, enumName: 'GuardTaskKind' })
  @IsIn(KINDS)
  kind: (typeof KINDS)[number];

  @ApiPropertyOptional({
    type: String,
    maxLength: 120,
    description: 'Required for a custom task; not for an inspection.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 120, withParams({ min: 1, max: 120 }))
  title?: string;

  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(1, 2000, withParams({ min: 1, max: 2000 }))
  details?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'An inspection’s unit, in closed mode (UNIT_NOT_CLOSED).',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'For one guard: exactly one of `guardId`, `gateId`, `zoneId`.',
  })
  @IsOptional()
  @IsUUID()
  guardId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A place in service.',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @ToInstant()
  @IsDate()
  dueAt?: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The inspection request it answers (ADR 0063): an open one of the same unit (INSPECTION_REQUEST_NOT_FOUND otherwise); an inspection only.',
  })
  @IsOptional()
  @IsUUID()
  requestId?: string;
}

export class CancelGuardTaskDto {
  @ApiProperty({
    enum: [...REASON_CODES.guardTaskCancel],
    enumName: 'GuardTaskCancel',
  })
  @IsString()
  reasonCode: string;
}

export class CompleteGuardTaskDto {
  @ApiProperty({
    enum: [...REASON_CODES.guardTaskOutcome],
    enumName: 'GuardTaskOutcome',
    description:
      'An inspection: `all_clear` or `issue_found`; a custom task: `done`.',
  })
  @IsString()
  outcome: string;

  @ApiPropertyOptional({ type: String, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(0, 2000, withParams({ min: 0, max: 2000 }))
  note?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Finalized `guard_task_photo` files of the caller, 5 at most; an inspection needs one at least.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, withParams({ min: 0, max: 5 }))
  @IsUUID(undefined, { each: true })
  photoFileIds?: string[];
}

export class StaffGuardTasksQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ enum: KINDS })
  @IsOptional()
  @IsIn(KINDS)
  kind?: (typeof KINDS)[number];

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  guardId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}
