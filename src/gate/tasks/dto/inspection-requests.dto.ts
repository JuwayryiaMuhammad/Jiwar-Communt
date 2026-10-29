import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';

/** A closed unit's owner, or its proxy, asks for a visit (ADR 0063). */
export class NewInspectionRequestDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'The compound’s day, from today to 90 days ahead.',
  })
  @IsLocalDate(withParams({ format: 'YYYY-MM-DD' }))
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
