import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PageQueryDto } from '../../core/common/http/list';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  AGENDA_LIMITS,
  AGENDA_STATUSES,
  type AgendaStatus,
} from './agenda.service';

export class ProposeAgendaDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: AGENDA_LIMITS.title })
  @IsString()
  @Length(
    1,
    AGENDA_LIMITS.title,
    withParams({ min: 1, max: AGENDA_LIMITS.title }),
  )
  title: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: AGENDA_LIMITS.body })
  @IsString()
  @Length(
    1,
    AGENDA_LIMITS.body,
    withParams({ min: 1, max: AGENDA_LIMITS.body }),
  )
  body: string;
}

export class AgendaQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: AGENDA_STATUSES,
    enumName: 'AgendaProposalStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(AGENDA_STATUSES, withParams({ allowed: [...AGENDA_STATUSES] }))
  status?: AgendaStatus;
}

export const AGENDA_OUTCOMES = ['accepted', 'declined'] as const;

export class DecideAgendaDto {
  @ApiProperty({ enum: AGENDA_OUTCOMES, enumName: 'AgendaProposalOutcome' })
  @IsIn(AGENDA_OUTCOMES, withParams({ allowed: [...AGENDA_OUTCOMES] }))
  outcome: (typeof AGENDA_OUTCOMES)[number];

  @ApiProperty({
    type: String,
    required: false,
    description: 'Required to decline: from the closed list `agendaDecline`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: AGENDA_LIMITS.note,
    description: 'The board’s words to the proposer. Write no one’s name.',
  })
  @IsOptional()
  @IsString()
  @Length(
    1,
    AGENDA_LIMITS.note,
    withParams({ min: 1, max: AGENDA_LIMITS.note }),
  )
  note?: string;
}
