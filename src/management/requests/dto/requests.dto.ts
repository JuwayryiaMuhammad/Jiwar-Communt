import { ApiProperty } from '@nestjs/swagger';
import { ManagementRequestStatus, ManagementRequestType } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SlotChoiceDto } from '../../appointments/dto/appointments.dto';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MAX_ATTACHMENTS, MESSAGE_LENGTH } from '../messages.service';
import { RATING, RATING_COMMENT_LENGTH } from '../rating.service';

const BOOLEAN = ['true', 'false'] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CreateRequestDto {
  @ApiProperty({
    enum: ManagementRequestType,
    enumName: 'ManagementRequestType',
    description: 'An `appointment` names its slot in `appointment`.',
  })
  @IsEnum(
    ManagementRequestType,
    withParams({ allowed: Object.values(ManagementRequestType) }),
  )
  type: ManagementRequestType;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active topic of the compound (TOPIC_NOT_AVAILABLE).',
  })
  @IsUUID()
  topicId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'One of the author’s units, when the request is about one.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    type: String,
    minLength: MESSAGE_LENGTH.min,
    maxLength: MESSAGE_LENGTH.max,
    description: 'What the request says: it becomes its first message.',
  })
  @IsString()
  @Length(
    MESSAGE_LENGTH.min,
    MESSAGE_LENGTH.max,
    withParams({ ...MESSAGE_LENGTH }),
  )
  body: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    maxItems: MAX_ATTACHMENTS,
    description:
      'The caller’s own finalized `request_attachment` files (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS, withParams({ min: 0, max: MAX_ATTACHMENTS }))
  @IsUUID(undefined, { each: true })
  attachmentFileIds?: string[];

  @ApiProperty({
    type: SlotChoiceDto,
    required: false,
    description:
      'Required for an `appointment` request, refused for any other type.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SlotChoiceDto)
  appointment?: SlotChoiceDto;
}

export class CreateRequestOnBehalfDto extends CreateRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The resident the request is for: an active resident or family account (AUTHOR_NOT_ELIGIBLE). They are its author.',
  })
  @IsUUID()
  authorAccountId: string;

  @ApiProperty({
    enum: REASON_CODES.managementRequestOnBehalf,
    description: 'How the resident reached the management.',
  })
  @IsString()
  reasonCode: string;
}

export class ResidentRequestsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: ManagementRequestStatus,
    enumName: 'ManagementRequestStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    ManagementRequestStatus,
    withParams({ allowed: Object.values(ManagementRequestStatus) }),
  )
  status?: ManagementRequestStatus;

  @ApiProperty({
    enum: ManagementRequestType,
    enumName: 'ManagementRequestType',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    ManagementRequestType,
    withParams({ allowed: Object.values(ManagementRequestType) }),
  )
  type?: ManagementRequestType;
}

export class StaffRequestsQueryDto extends ResidentRequestsQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  topicId?: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'An account id, `me` for the caller’s own, or `none` for the unassigned queue.',
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^(me|none|${UUID.source.slice(1, -1)})$`, 'i'))
  assignee?: string;

  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description:
      '`true`: only requests whose response time has passed with no response in the cycle.',
  })
  @IsOptional()
  @IsIn([...BOOLEAN], withParams({ allowed: [...BOOLEAN] }))
  overdue?: (typeof BOOLEAN)[number];

  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description: '`true`: only requests whose current cycle was escalated.',
  })
  @IsOptional()
  @IsIn([...BOOLEAN], withParams({ allowed: [...BOOLEAN] }))
  escalated?: (typeof BOOLEAN)[number];
}

export class AssignRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'An active account holding `requests.handle` (ASSIGNEE_NOT_ELIGIBLE), or null for the unassigned queue.',
  })
  @ValidateIf((o: AssignRequestDto) => o.assigneeId !== null)
  @IsUUID()
  assigneeId: string | null;
}

export class PostRequestMessageDto {
  @ApiProperty({
    type: String,
    minLength: MESSAGE_LENGTH.min,
    maxLength: MESSAGE_LENGTH.max,
  })
  @IsString()
  @Length(
    MESSAGE_LENGTH.min,
    MESSAGE_LENGTH.max,
    withParams({ ...MESSAGE_LENGTH }),
  )
  body: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    maxItems: MAX_ATTACHMENTS,
    description:
      'The caller’s own finalized `request_attachment` files (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS, withParams({ min: 0, max: MAX_ATTACHMENTS }))
  @IsUUID(undefined, { each: true })
  attachmentFileIds?: string[];
}

export class PostStaffRequestMessageDto extends PostRequestMessageDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    default: false,
    description:
      'A staff note: the author never sees it or its attachments, and it moves nothing.',
  })
  @IsOptional()
  @IsBoolean()
  internal?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    default: false,
    description:
      'The official reply: the request becomes answered. Chosen when sending and never changed; not with `internal`.',
  })
  @IsOptional()
  @IsBoolean()
  official?: boolean;
}

export class CloseRequestDto {
  @ApiProperty({ enum: REASON_CODES.managementRequestClose })
  @IsString()
  reasonCode: string;
}

export class RateRequestDto {
  @ApiProperty({ type: Number, minimum: RATING.min, maximum: RATING.max })
  @IsInt(withParams({ ...RATING }))
  @Min(RATING.min, withParams({ ...RATING }))
  @Max(RATING.max, withParams({ ...RATING }))
  rating: number;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: RATING_COMMENT_LENGTH.max,
  })
  @IsOptional()
  @IsString()
  @Length(
    0,
    RATING_COMMENT_LENGTH.max,
    withParams({ ...RATING_COMMENT_LENGTH }),
  )
  comment?: string;
}
