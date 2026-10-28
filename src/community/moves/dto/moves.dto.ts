import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MOVE_DIRECTIONS } from '../move-checklist';

const DATE = withParams({ format: 'YYYY-MM-DD' });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The residing primary's notice to move out (ADR 0063). */
export class MoveOutNoticeDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'The compound’s day, from today to a year ahead.',
  })
  @Matches(ISO_DATE, DATE)
  plannedOn: string;
}

/** A move the management plans for an active occupancy (ADR 0063). */
export class NewMoveDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('all')
  occupancyId: string;

  @ApiProperty({ enum: MOVE_DIRECTIONS })
  @IsIn([...MOVE_DIRECTIONS], withParams({ allowed: [...MOVE_DIRECTIONS] }))
  direction: string;

  @ApiProperty({ type: String, format: 'date' })
  @Matches(ISO_DATE, DATE)
  plannedOn: string;
}

export const MOVE_STATUSES = ['planned', 'done', 'cancelled'] as const;

export class MoveBoardQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID('all')
  unitId?: string;

  @ApiProperty({
    enum: MOVE_STATUSES,
    required: false,
    description: 'Default: planned, unless a unit is named (then all).',
  })
  @IsOptional()
  @IsIn([...MOVE_STATUSES], withParams({ allowed: [...MOVE_STATUSES] }))
  status?: string;
}

/** A manual step of the checklist, by its key. */
export class MoveStepDto {
  @ApiProperty({
    type: String,
    description: 'A manual step of the caller’s side (see the checklist).',
  })
  @Matches(/^[a-z][a-z_]{1,39}$/, withParams({ format: 'step key' }))
  step: string;
}
