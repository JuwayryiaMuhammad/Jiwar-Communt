import { ApiProperty } from '@nestjs/swagger';
import { SuggestionStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MAX_ATTACHMENTS } from '../../content/attachments';
import {
  DONE_NOTE_MAX,
  PUBLIC_TEXT_MAX,
  PUBLIC_TITLE_MAX,
  RESPONSE_MAX,
  SUGGESTION_BODY,
} from '../suggestion-rules';

const RESPONSE = { min: 1, max: RESPONSE_MAX };
const BOOLEAN = ['true', 'false'] as const;
const STATUSES = Object.values(SuggestionStatus);

const text = (max: number, description?: string) =>
  ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: 1,
    maxLength: max,
    description,
  });

export class CreateSuggestionDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active topic of the compound (TOPIC_NOT_AVAILABLE).',
  })
  @IsUUID()
  topicId: string;

  @ApiProperty({
    type: String,
    minLength: SUGGESTION_BODY.min,
    maxLength: SUGGESTION_BODY.max,
    description:
      'The suggestion, in the resident’s words. Private to its author and the staff.',
  })
  @IsString()
  @Length(SUGGESTION_BODY.min, SUGGESTION_BODY.max, withParams(SUGGESTION_BODY))
  body: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'One of the author’s units, when the suggestion is about one.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class MoveSuggestionDto {
  @ApiProperty({
    enum: SuggestionStatus,
    enumName: 'SuggestionStatus',
    description:
      'A step forward: `under_review`, `planned`, `done`, or `declined`. `done` and `declined` are final.',
  })
  @IsEnum(SuggestionStatus, withParams({ allowed: STATUSES }))
  status: SuggestionStatus;

  @ApiProperty({
    type: String,
    required: false,
    minLength: RESPONSE.min,
    maxLength: RESPONSE.max,
    description:
      'What the staff tell the author. Required to decline. Replaces an earlier answer.',
  })
  @IsOptional()
  @IsString()
  @Length(RESPONSE.min, RESPONSE.max, withParams(RESPONSE))
  response?: string;
}

export class RespondSuggestionDto {
  @ApiProperty({
    type: String,
    minLength: RESPONSE.min,
    maxLength: RESPONSE.max,
    description: 'What the staff tell the author. Replaces an earlier answer.',
  })
  @IsString()
  @Length(RESPONSE.min, RESPONSE.max, withParams(RESPONSE))
  response: string;
}

/**
 * How the suggestion is shown on the board: the staff's summary, never the
 * resident's words or who they are.
 */
export class PublishSuggestionDto {
  @text(
    PUBLIC_TITLE_MAX,
    'A language is whole or absent; at least one is there.',
  )
  @IsOptional()
  @IsString()
  titleEn?: string | null;

  @text(PUBLIC_TEXT_MAX)
  @IsOptional()
  @IsString()
  textEn?: string | null;

  @text(PUBLIC_TITLE_MAX)
  @IsOptional()
  @IsString()
  titleAr?: string | null;

  @text(PUBLIC_TEXT_MAX)
  @IsOptional()
  @IsString()
  textAr?: string | null;
}

export class DoneNoteDto {
  @text(DONE_NOTE_MAX, 'What was done. English, Arabic or both; at least one.')
  @IsOptional()
  @IsString()
  noteEn?: string | null;

  @text(DONE_NOTE_MAX)
  @IsOptional()
  @IsString()
  noteAr?: string | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    maxItems: MAX_ATTACHMENTS,
    description:
      'The photos the note shows from now on: ids it already shows to keep, and the caller’s own finalized `community_attachment` files to add (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS, withParams({ min: 0, max: MAX_ATTACHMENTS }))
  @IsUUID(undefined, { each: true })
  attachmentFileIds?: string[];
}

export class StaffSuggestionsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: SuggestionStatus,
    enumName: 'SuggestionStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(SuggestionStatus, withParams({ allowed: STATUSES }))
  status?: SuggestionStatus;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  topicId?: string;

  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description: '`true`: only those on the board; `false`: only those not.',
  })
  @IsOptional()
  @IsIn([...BOOLEAN], withParams({ allowed: [...BOOLEAN] }))
  published?: 'true' | 'false';
}

export class BoardQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  topicId?: string;
}
