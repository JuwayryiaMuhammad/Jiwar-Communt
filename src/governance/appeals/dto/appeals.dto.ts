import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { APPROVAL_LIMITS } from '../../approvals/approval-rules';
import {
  APPEAL_LIMITS,
  APPEAL_STATUSES,
  BOARD_APPEAL_KINDS,
  type AppealStatus,
  type BoardAppealKind,
} from '../appeal-rules';
import {
  MANAGEMENT_COMPLAINT_CATEGORIES,
  type ManagementComplaintCategory,
} from '../management-complaints';

export class LodgeBoardAppealDto {
  @ApiProperty({ enum: BOARD_APPEAL_KINDS, enumName: 'BoardAppealKind' })
  @IsIn(BOARD_APPEAL_KINDS, withParams({ allowed: [...BOARD_APPEAL_KINDS] }))
  kind: BoardAppealKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The decision: a vehicle fine or a violation whose appeal the staff upheld, a facility suspension in force, a rejected invoice dispute.',
  })
  @IsUUID()
  subjectId: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: APPEAL_LIMITS.grounds })
  @IsString()
  @Length(
    1,
    APPEAL_LIMITS.grounds,
    withParams({ min: 1, max: APPEAL_LIMITS.grounds }),
  )
  grounds: string;

  @ApiProperty({
    type: [String],
    required: false,
    maxItems: APPEAL_LIMITS.attachments,
    description:
      'The caller’s uploads of purpose `board_appeal_attachment` (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    APPEAL_LIMITS.attachments,
    withParams({ max: APPEAL_LIMITS.attachments }),
  )
  @IsUUID('all', { each: true })
  attachmentIds?: string[];
}

export class BoardAppealsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: APPEAL_STATUSES,
    enumName: 'BoardAppealStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(APPEAL_STATUSES, withParams({ allowed: [...APPEAL_STATUSES] }))
  status?: AppealStatus;
}

export const APPEAL_OUTCOMES = ['uphold', 'overturn'] as const;

export class ProposeAppealMotionDto {
  @ApiProperty({ enum: APPEAL_OUTCOMES, enumName: 'AppealMotionOutcome' })
  @IsIn(APPEAL_OUTCOMES, withParams({ allowed: [...APPEAL_OUTCOMES] }))
  outcome: (typeof APPEAL_OUTCOMES)[number];

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: APPROVAL_LIMITS.rationale,
    description:
      'The board’s reasoned decision, as the appellant and the management will read it. Write no one’s name.',
  })
  @IsString()
  @Length(
    1,
    APPROVAL_LIMITS.rationale,
    withParams({ min: 1, max: APPROVAL_LIMITS.rationale }),
  )
  rationale: string;
}

export class FileManagementComplaintDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A unit the caller owns or is the primary of (BOARD_APPEAL_NOT_ALLOWED).',
  })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    enum: MANAGEMENT_COMPLAINT_CATEGORIES,
    enumName: 'ManagementComplaintCategory',
  })
  @IsIn(
    MANAGEMENT_COMPLAINT_CATEGORIES,
    withParams({ allowed: [...MANAGEMENT_COMPLAINT_CATEGORIES] }),
  )
  category: ManagementComplaintCategory;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: 1,
    description:
      'The number of the management request it is about (MR-000123 is 123), if any.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(withParams({ min: 1, max: 999999999 }))
  @Min(1, withParams({ min: 1, max: 999999999 }))
  @Max(999999999, withParams({ min: 1, max: 999999999 }))
  requestNumber?: number;

  @ApiProperty({ type: String, minLength: 1, maxLength: APPEAL_LIMITS.grounds })
  @IsString()
  @Length(
    1,
    APPEAL_LIMITS.grounds,
    withParams({ min: 1, max: APPEAL_LIMITS.grounds }),
  )
  grounds: string;

  @ApiProperty({
    type: [String],
    required: false,
    maxItems: APPEAL_LIMITS.attachments,
    description:
      'The caller’s uploads of purpose `board_appeal_attachment` (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    APPEAL_LIMITS.attachments,
    withParams({ max: APPEAL_LIMITS.attachments }),
  )
  @IsUUID('all', { each: true })
  attachmentIds?: string[];
}
