import { ApiProperty } from '@nestjs/swagger';
import { EventRsvpResponse } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { AudienceDto } from '../../audience/audience';
import { MAX_ATTACHMENTS } from '../../content/attachments';
import { EVENT_MAX_GUESTS } from '../../settings/engagement-settings.service';
import { EVENT_STATUSES, type EventStatus } from '../event-rules';
import {
  EVENT_CAPACITY,
  EVENT_DESCRIPTION_MAX,
  EVENT_PLACE_MAX,
  EVENT_TITLE_MAX,
} from '../events.service';

const TITLE = { min: 1, max: EVENT_TITLE_MAX };
const DESCRIPTION = { min: 1, max: EVENT_DESCRIPTION_MAX };
const PLACE = { min: 1, max: EVENT_PLACE_MAX };

const text = (limits: { min: number; max: number }, description?: string) =>
  ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: limits.min,
    maxLength: limits.max,
    description,
  });

class EventTextDto {
  @text(TITLE, 'A language is whole or absent; at least one is there.')
  @IsOptional()
  @IsString()
  titleEn?: string | null;

  @text(DESCRIPTION)
  @IsOptional()
  @IsString()
  descriptionEn?: string | null;

  @text(TITLE)
  @IsOptional()
  @IsString()
  titleAr?: string | null;

  @text(DESCRIPTION)
  @IsOptional()
  @IsString()
  descriptionAr?: string | null;

  @ApiProperty({
    type: Number,
    required: false,
    nullable: true,
    minimum: EVENT_CAPACITY.min,
    maximum: EVENT_CAPACITY.max,
    description:
      'Seats in all, guests included. Null or absent: no limit. Never below the seats already taken.',
  })
  @IsOptional()
  @IsInt(withParams({ ...EVENT_CAPACITY }))
  @Min(EVENT_CAPACITY.min, withParams({ ...EVENT_CAPACITY }))
  @Max(EVENT_CAPACITY.max, withParams({ ...EVENT_CAPACITY }))
  capacity?: number | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    maxItems: MAX_ATTACHMENTS,
    description:
      'The files it shows from now on: ids it already shows to keep, and the caller’s own finalized `community_attachment` files to add (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS, withParams({ min: 0, max: MAX_ATTACHMENTS }))
  @IsUUID(undefined, { each: true })
  attachmentFileIds?: string[];
}

export class CreateEventDto extends EventTextDto {
  @ApiProperty({
    type: String,
    minLength: PLACE.min,
    maxLength: PLACE.max,
    description: 'Where, in the staff’s words.',
  })
  @IsString()
  @Length(PLACE.min, PLACE.max, withParams(PLACE))
  place: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'After `startsAt` (ENDS_BEFORE_START).',
  })
  @Type(() => Date)
  @IsDate()
  endsAt: Date;

  @ApiProperty({
    type: AudienceDto,
    required: false,
    description: 'Absent: the whole compound, everyone. Never changes.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceDto)
  audience?: AudienceDto;
}

/** What is absent stays. Only an event that has not started changes. */
export class UpdateEventDto extends EventTextDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: PLACE.min,
    maxLength: PLACE.max,
  })
  @IsOptional()
  @IsString()
  @Length(PLACE.min, PLACE.max, withParams(PLACE))
  place?: string;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;
}

export class CancelEventDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `communityEventCancel`.',
  })
  @IsString()
  reasonCode: string;
}

export class RsvpDto {
  @ApiProperty({ enum: EventRsvpResponse, enumName: 'EventRsvpResponse' })
  @IsEnum(
    EventRsvpResponse,
    withParams({ allowed: Object.values(EventRsvpResponse) }),
  )
  response: EventRsvpResponse;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: EVENT_MAX_GUESTS.min,
    maximum: EVENT_MAX_GUESTS.max,
    description:
      'People the caller brings, when going. At most the compound’s limit (INVALID_NUMBER, params.max). Absent: none.',
  })
  @IsOptional()
  @IsInt(withParams({ ...EVENT_MAX_GUESTS }))
  @Min(EVENT_MAX_GUESTS.min, withParams({ ...EVENT_MAX_GUESTS }))
  @Max(EVENT_MAX_GUESTS.max, withParams({ ...EVENT_MAX_GUESTS }))
  guests?: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'The unit the caller answers from. Required only when the event is put to several of their units.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class StaffEventsQueryDto extends PageQueryDto {
  @ApiProperty({ enum: EVENT_STATUSES, required: false })
  @IsOptional()
  @IsIn([...EVENT_STATUSES], withParams({ allowed: [...EVENT_STATUSES] }))
  status?: EventStatus;
}

export class AttendeesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: EventRsvpResponse,
    enumName: 'EventRsvpResponse',
    required: false,
    description: 'Absent: those who are going.',
  })
  @IsOptional()
  @IsEnum(
    EventRsvpResponse,
    withParams({ allowed: Object.values(EventRsvpResponse) }),
  )
  response?: EventRsvpResponse;
}
