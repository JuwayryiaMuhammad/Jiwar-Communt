import { ApiProperty } from '@nestjs/swagger';
import { NeighbourReportStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { CONVERSATION_MESSAGE_LENGTH } from '../conversations.service';
import { REPORT_NOTE_LENGTH } from '../reports.service';

/** The first message of a conversation, or a later one. Text only. */
export class ConversationMessageDto {
  @ApiProperty({
    type: String,
    minLength: CONVERSATION_MESSAGE_LENGTH.min,
    maxLength: CONVERSATION_MESSAGE_LENGTH.max,
  })
  @IsString()
  @Length(
    CONVERSATION_MESSAGE_LENGTH.min,
    CONVERSATION_MESSAGE_LENGTH.max,
    withParams({ ...CONVERSATION_MESSAGE_LENGTH }),
  )
  body: string;
}

export class ReportConversationDto {
  @ApiProperty({
    type: String,
    description:
      'From the closed list `neighbourConversationReport` (INVALID_REASON_CODE names the allowed ones).',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: REPORT_NOTE_LENGTH.min,
    maxLength: REPORT_NOTE_LENGTH.max,
    description: 'For the staff alone.',
  })
  @IsOptional()
  @IsString()
  @Length(
    REPORT_NOTE_LENGTH.min,
    REPORT_NOTE_LENGTH.max,
    withParams({ ...REPORT_NOTE_LENGTH }),
  )
  note?: string;
}

export class ReportsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: NeighbourReportStatus,
    enumName: 'NeighbourReportStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    NeighbourReportStatus,
    withParams({ allowed: Object.values(NeighbourReportStatus) }),
  )
  status?: NeighbourReportStatus;
}

export class CloseReportDto {
  @ApiProperty({
    type: String,
    description:
      'What was done, from the closed list `neighbourReportOutcome`. `post_removed` takes the post down with the case.',
  })
  @IsString()
  reasonCode: string;
}
