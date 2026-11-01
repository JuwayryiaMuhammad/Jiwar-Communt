import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../core/common/http/list';
import { ToInstant } from '../../core/common/validation/instant';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../core/common/validation/local-date';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  ACTION_STATUSES,
  AGENDA_ITEM_KINDS,
  MEETING_KINDS,
  MEETING_LIMITS,
  MEETING_STATUSES,
  type ActionStatus,
  type AgendaItemKind,
  type MeetingKind,
  type MeetingStatus,
} from './meeting-rules';

const L = MEETING_LIMITS;

export class MeetingAgendaItemDto {
  @ApiProperty({ enum: AGENDA_ITEM_KINDS, enumName: 'BoardMeetingAgendaKind' })
  @IsIn(AGENDA_ITEM_KINDS, withParams({ allowed: [...AGENDA_ITEM_KINDS] }))
  kind: AgendaItemKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'The pending approval request, the pending appeal to the board, or the owner’s open agenda proposal; none for `other`.',
  })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: L.agendaTitle,
    description: 'Only for `other`: the item in the board’s words.',
  })
  @IsOptional()
  @IsString()
  title?: string;
}

class MeetingFieldsDto {
  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    maxLength: L.location,
    description: 'Where it meets; null clears it.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  location?: string | null;

  @ApiProperty({
    type: [MeetingAgendaItemDto],
    required: false,
    maxItems: L.agendaItems,
    description:
      'The agenda, in order, as a whole (an update replaces it). Up to 30 items, each subject once.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(L.agendaItems, withParams({ min: 0, max: L.agendaItems }))
  @ValidateNested({ each: true })
  @Type(() => MeetingAgendaItemDto)
  agenda?: MeetingAgendaItemDto[];
}

export class ScheduleMeetingDto extends MeetingFieldsDto {
  @ApiProperty({ enum: MEETING_KINDS, enumName: 'BoardMeetingKind' })
  @IsIn(MEETING_KINDS, withParams({ allowed: [...MEETING_KINDS] }))
  kind: MeetingKind;

  @ApiProperty({ type: String, minLength: 1, maxLength: L.title })
  @IsString()
  @Length(1, L.title, withParams({ min: 1, max: L.title }))
  title: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When it meets: up to 30 days back (a meeting recorded after the fact) and a year ahead (INVALID_VALUE).',
  })
  @ToInstant()
  @IsDate()
  scheduledAt: Date;
}

export class UpdateMeetingDto extends MeetingFieldsDto {
  @ApiProperty({
    enum: MEETING_KINDS,
    enumName: 'BoardMeetingKind',
    required: false,
  })
  @IsOptional()
  @IsIn(MEETING_KINDS, withParams({ allowed: [...MEETING_KINDS] }))
  kind?: MeetingKind;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: L.title,
    required: false,
  })
  @IsOptional()
  @IsString()
  @Length(1, L.title, withParams({ min: 1, max: L.title }))
  title?: string;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @ToInstant()
  @IsDate()
  scheduledAt?: Date;
}

export class HoldMeetingDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'The seats present (board member ids), from the seats sitting now; the others are recorded absent. An empty list is a meeting nobody attended.',
  })
  @IsArray()
  @IsUUID('all', { each: true })
  presentMemberIds: string[];
}

export class LinkMinutesDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A board publication of kind `minutes` of the same board, not archived, linked to no other meeting.',
  })
  @IsUUID()
  publicationId: string;
}

export class AddActionDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: L.actionTitle })
  @IsString()
  @Length(1, L.actionTitle, withParams({ min: 1, max: L.actionTitle }))
  title: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'Who carries it out: a sitting member of the meeting’s board, or an active manager.',
  })
  @IsUUID()
  ownerAccountId: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The compound’s day it is due: today to a year ahead (DAY_OUT_OF_RANGE).',
  })
  @IsString()
  @IsLocalDate()
  dueOn: string;
}

export class CompleteActionDto {
  @ApiProperty({
    type: String,
    required: false,
    maxLength: L.doneNote,
    description: 'How it was done. Write no one’s name.',
  })
  @IsOptional()
  @IsString()
  @Length(1, L.doneNote, withParams({ min: 1, max: L.doneNote }))
  note?: string;
}

export class MeetingsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: MEETING_STATUSES,
    enumName: 'BoardMeetingStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(MEETING_STATUSES, withParams({ allowed: [...MEETING_STATUSES] }))
  status?: MeetingStatus;
}

export class MeetingActionsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: ACTION_STATUSES,
    enumName: 'BoardMeetingActionStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(ACTION_STATUSES, withParams({ allowed: [...ACTION_STATUSES] }))
  status?: ActionStatus;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Only the caller’s own action items.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  mine?: boolean;
}
