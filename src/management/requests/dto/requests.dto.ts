import { ApiProperty } from '@nestjs/swagger';
import { ManagementRequestStatus, ManagementRequestType } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MESSAGE_LENGTH } from '../messages.service';

/** What a resident opens by writing: an appointment is booked with a slot. */
export const WRITTEN_TYPES = ['question', 'general'] as const;
const BOOLEAN = ['true', 'false'] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CreateRequestDto {
  @ApiProperty({ enum: WRITTEN_TYPES })
  @IsIn([...WRITTEN_TYPES], withParams({ allowed: [...WRITTEN_TYPES] }))
  type: (typeof WRITTEN_TYPES)[number];

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
