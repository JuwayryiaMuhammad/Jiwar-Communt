import { ApiProperty } from '@nestjs/swagger';
import { NeighbourComplaintStatus } from '@prisma/client';
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
import { MAX_ATTACHMENTS, MESSAGE_LENGTH } from '../complaint-messages.service';
import { UNIT_CODE_LENGTH } from '../complaints.service';

const BOOLEAN = ['true', 'false'] as const;
export const NOTICE_LENGTH = { min: 1, max: 2000 } as const;

function Attachments() {
  return (target: object, key: string) => {
    ApiProperty({
      type: [String],
      format: 'uuid',
      required: false,
      maxItems: MAX_ATTACHMENTS,
      description:
        'The caller’s own finalized `complaint_evidence` files: photos or PDF (FILE_NOT_AVAILABLE).',
    })(target, key);
    IsOptional()(target, key);
    IsArray()(target, key);
    ArrayMaxSize(MAX_ATTACHMENTS, withParams({ min: 0, max: MAX_ATTACHMENTS }))(
      target,
      key,
    );
    IsUUID(undefined, { each: true })(target, key);
  };
}

function Body(description: string) {
  return (target: object, key: string) => {
    ApiProperty({
      type: String,
      minLength: MESSAGE_LENGTH.min,
      maxLength: MESSAGE_LENGTH.max,
      description,
    })(target, key);
    IsString()(target, key);
    Length(
      MESSAGE_LENGTH.min,
      MESSAGE_LENGTH.max,
      withParams({ ...MESSAGE_LENGTH }),
    )(target, key);
  };
}

export class CreateComplaintDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'An active complaint category of the compound (CATEGORY_NOT_AVAILABLE).',
  })
  @IsUUID()
  categoryId: string;

  @ApiProperty({
    type: String,
    minLength: UNIT_CODE_LENGTH.min,
    maxLength: UNIT_CODE_LENGTH.max,
    example: 'B2-104',
    description:
      'The code of the unit complained about (UNIT_CODE_UNKNOWN). Never one of the author’s own units (OWN_UNIT).',
  })
  @IsString()
  @Length(
    UNIT_CODE_LENGTH.min,
    UNIT_CODE_LENGTH.max,
    withParams({ ...UNIT_CODE_LENGTH }),
  )
  targetUnitCode: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'One of the author’s own units, when they have several.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @Body('What the complaint says: it becomes its first message.')
  body: string;

  @Attachments()
  attachmentFileIds?: string[];
}

export class PostComplaintMessageDto {
  @Body('The message.')
  body: string;

  @Attachments()
  attachmentFileIds?: string[];
}

export class ComplaintsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: NeighbourComplaintStatus,
    enumName: 'NeighbourComplaintStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    NeighbourComplaintStatus,
    withParams({ allowed: Object.values(NeighbourComplaintStatus) }),
  )
  status?: NeighbourComplaintStatus;

  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description: '`true`: neither resolved nor dismissed. `false`: only those.',
  })
  @IsOptional()
  @IsIn(BOOLEAN, withParams({ allowed: [...BOOLEAN] }))
  open?: 'true' | 'false';
}

export class StaffComplaintsQueryDto extends ComplaintsQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'Complaints against this unit: its history.',
  })
  @IsOptional()
  @IsUUID()
  targetUnitId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'Complaints filed by this account.',
  })
  @IsOptional()
  @IsUUID()
  authorId?: string;
}

/** Ending a complaint: a code from a closed list, never text. */
export class ComplaintReasonDto {
  @ApiProperty({
    type: String,
    description:
      'A code of the action’s list: `neighbourComplaintResolve` or `neighbourComplaintDismiss` (INVALID_REASON_CODE names the allowed ones).',
  })
  @IsString()
  reasonCode: string;
}

export class SendNoticeDto {
  @ApiProperty({
    type: String,
    minLength: NOTICE_LENGTH.min,
    maxLength: NOTICE_LENGTH.max,
    description:
      'The management’s own words to the unit. The only text of the matter the unit ever reads: never the complaint’s.',
  })
  @IsString()
  @Length(
    NOTICE_LENGTH.min,
    NOTICE_LENGTH.max,
    withParams({ ...NOTICE_LENGTH }),
  )
  body: string;
}
