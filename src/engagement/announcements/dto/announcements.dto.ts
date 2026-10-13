import { ApiProperty } from '@nestjs/swagger';
import {
  AnnouncementKind,
  AnnouncementPriority,
  WorksAreaKind,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { AudienceDto } from '../../audience/audience';
import { MAX_ATTACHMENTS } from '../../content/attachments';
import {
  ANNOUNCEMENT_STATUSES,
  BODY_MAX,
  PLACE_MAX,
  TITLE_MAX,
} from '../announcements.service';
import type { AnnouncementStatus } from '../announcement-rules';

const TITLE = { min: 1, max: TITLE_MAX };
const BODY = { min: 1, max: BODY_MAX };
const PLACE = { min: 1, max: PLACE_MAX };
const BOOLEAN = ['true', 'false'] as const;

const text = (limits: { min: number; max: number }, description?: string) =>
  ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: limits.min,
    maxLength: limits.max,
    description,
  });

/** Where works are and when. */
export class WorksDto {
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

  @ApiProperty({ enum: WorksAreaKind, enumName: 'WorksAreaKind' })
  @IsEnum(WorksAreaKind, withParams({ allowed: Object.values(WorksAreaKind) }))
  areaKind: WorksAreaKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description: 'One of the compound’s gates; only with `areaKind: gate`.',
  })
  @IsOptional()
  @IsUUID()
  gateId?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: PLACE.min,
    maxLength: PLACE.max,
    description: 'Where, in the staff’s words.',
  })
  @IsOptional()
  @IsString()
  @Length(PLACE.min, PLACE.max, withParams(PLACE))
  place?: string | null;
}

class AnnouncementContentDto {
  @text(TITLE, 'A language is whole or absent; at least one is there.')
  @IsOptional()
  @IsString()
  titleEn?: string | null;

  @text(BODY)
  @IsOptional()
  @IsString()
  bodyEn?: string | null;

  @text(TITLE)
  @IsOptional()
  @IsString()
  titleAr?: string | null;

  @text(BODY)
  @IsOptional()
  @IsString()
  bodyAr?: string | null;

  @ApiProperty({
    enum: AnnouncementPriority,
    enumName: 'AnnouncementPriority',
    required: false,
    description:
      'An `important` one tells its audience when it comes out, and may be pinned.',
  })
  @IsOptional()
  @IsEnum(
    AnnouncementPriority,
    withParams({ allowed: Object.values(AnnouncementPriority) }),
  )
  priority?: AnnouncementPriority;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    nullable: true,
    description: 'Stays on top until then. Only when `important`.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  pinnedUntil?: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    nullable: true,
    description:
      'No longer shown from then on. A general announcement’s only: works end by their own dates.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date | null;

  @ApiProperty({
    type: AudienceDto,
    required: false,
    description:
      'Absent: the whole compound, everyone. May change only until the announcement is out.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceDto)
  audience?: AudienceDto;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    maxItems: MAX_ATTACHMENTS,
    description:
      'The files it shows from now on: ids it already shows (`attachments[].id`) to keep, and the caller’s own finalized `community_attachment` files to add (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS, withParams({ min: 0, max: MAX_ATTACHMENTS }))
  @IsUUID(undefined, { each: true })
  attachmentFileIds?: string[];
}

export class CreateAnnouncementDto extends AnnouncementContentDto {
  @ApiProperty({
    enum: AnnouncementKind,
    enumName: 'AnnouncementKind',
    description: '`works`: works and closures, with `works`. Never changes.',
  })
  @IsEnum(
    AnnouncementKind,
    withParams({ allowed: Object.values(AnnouncementKind) }),
  )
  kind: AnnouncementKind;

  @ApiProperty({
    type: WorksDto,
    required: false,
    description: 'Required for `works`, refused otherwise.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorksDto)
  works?: WorksDto;
}

/** What is absent stays; a new text makes a new version. */
export class UpdateAnnouncementDto extends AnnouncementContentDto {
  @ApiProperty({
    type: WorksDto,
    required: false,
    description: 'Replaces the dates and the area of works as a whole.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorksDto)
  works?: WorksDto;
}

export class PublishAnnouncementDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'When it comes out. Absent: now. Not in the past.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  publishAt?: Date;
}

export class StaffAnnouncementsQueryDto extends PageQueryDto {
  @ApiProperty({ enum: ANNOUNCEMENT_STATUSES, required: false })
  @IsOptional()
  @IsIn(
    [...ANNOUNCEMENT_STATUSES],
    withParams({ allowed: [...ANNOUNCEMENT_STATUSES] }),
  )
  status?: AnnouncementStatus;

  @ApiProperty({
    enum: AnnouncementKind,
    enumName: 'AnnouncementKind',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    AnnouncementKind,
    withParams({ allowed: Object.values(AnnouncementKind) }),
  )
  kind?: AnnouncementKind;
}

export class AnnouncementsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: AnnouncementKind,
    enumName: 'AnnouncementKind',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    AnnouncementKind,
    withParams({ allowed: Object.values(AnnouncementKind) }),
  )
  kind?: AnnouncementKind;

  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description: '`true`: only what is pinned now.',
  })
  @IsOptional()
  @IsIn([...BOOLEAN], withParams({ allowed: [...BOOLEAN] }))
  pinned?: 'true' | 'false';
}
