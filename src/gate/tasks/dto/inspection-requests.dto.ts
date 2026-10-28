import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

/** A closed unit's owner, or its proxy, asks for a visit (ADR 0063). */
export class NewInspectionRequestDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'The compound’s day, from today to 90 days ahead.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, withParams({ format: 'YYYY-MM-DD' }))
  preferredOn: string;
}

export const INSPECTION_REQUEST_STATUSES = [
  'open',
  'scheduled',
  'done',
  'cancelled',
] as const;

export class InspectionRequestsQueryDto {
  @ApiPropertyOptional({
    enum: INSPECTION_REQUEST_STATUSES,
    description: 'Default: open.',
  })
  @IsOptional()
  @IsIn(
    [...INSPECTION_REQUEST_STATUSES],
    withParams({ allowed: [...INSPECTION_REQUEST_STATUSES] }),
  )
  status?: string;
}
