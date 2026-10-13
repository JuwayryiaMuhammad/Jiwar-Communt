import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { EVENT_MAX_GUESTS } from '../engagement-settings.service';

export class UpdateEngagementSettingsDto {
  @ApiProperty({
    type: Number,
    required: false,
    minimum: EVENT_MAX_GUESTS.min,
    maximum: EVENT_MAX_GUESTS.max,
    description: 'Guests one "going" answer to an event may bring, at most.',
  })
  @IsOptional()
  @IsInt(withParams({ ...EVENT_MAX_GUESTS }))
  @Min(EVENT_MAX_GUESTS.min, withParams({ ...EVENT_MAX_GUESTS }))
  @Max(EVENT_MAX_GUESTS.max, withParams({ ...EVENT_MAX_GUESTS }))
  eventMaxGuests?: number;
}
