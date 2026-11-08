import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import { CALL_NEEDED } from '../reinforcement.service';

export const CALL_STATUSES = ['open', 'filled', 'closed', 'cancelled'] as const;
export const SUGGESTION_STATUSES = [
  'open',
  'answered',
  'dismissed',
  'lapsed',
] as const;

export class SendReinforcementCallDto {
  @ApiProperty({
    type: Number,
    minimum: CALL_NEEDED.min,
    maximum: CALL_NEEDED.max,
    description: 'How many technicians are needed: the call is filled then.',
  })
  @IsInt()
  @Min(CALL_NEEDED.min, withParams({ ...CALL_NEEDED }))
  @Max(CALL_NEEDED.max, withParams({ ...CALL_NEEDED }))
  needed: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'From 15 minutes to 12 hours ahead; the call closes then.',
  })
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: '1 to 12 hours after the start.',
  })
  @ToInstant()
  @IsDate()
  endsAt: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A zone in service; absent for the whole compound.',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The open suggestion it answers (409 REINFORCEMENT_SUGGESTION_DECIDED once decided).',
  })
  @IsOptional()
  @IsUUID()
  suggestionId?: string;
}

export class ReinforcementCallsQueryDto {
  @ApiPropertyOptional({
    enum: CALL_STATUSES,
    enumName: 'ReinforcementCallStatus',
    description: 'Default: all.',
  })
  @IsOptional()
  @IsIn(CALL_STATUSES)
  status?: (typeof CALL_STATUSES)[number];
}

export class ReinforcementSuggestionsQueryDto {
  @ApiPropertyOptional({
    enum: SUGGESTION_STATUSES,
    enumName: 'ReinforcementSuggestionStatus',
    description: 'Default: all.',
  })
  @IsOptional()
  @IsIn(SUGGESTION_STATUSES)
  status?: (typeof SUGGESTION_STATUSES)[number];
}

export class ReinforcementReasonDto {
  @ApiProperty({
    type: String,
    description:
      'From `reinforcementDismiss` (a suggestion) or `reinforcementCancel` (a call).',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
