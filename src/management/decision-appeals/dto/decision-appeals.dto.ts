import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  DECISION_APPEAL_KINDS,
  DECISION_APPEAL_LIMITS,
  DECISION_APPEAL_OUTCOMES,
  DECISION_APPEAL_STATUSES,
  type DecisionAppealKind,
  type DecisionAppealOutcome,
  type DecisionAppealStatus,
} from '../appeal-rules';

/** A local day, YYYY-MM-DD (as the vehicles' approval takes it). */
const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class LodgeDecisionAppealDto {
  @ApiProperty({ enum: DECISION_APPEAL_KINDS, enumName: 'DecisionAppealKind' })
  @IsIn(
    DECISION_APPEAL_KINDS,
    withParams({ allowed: [...DECISION_APPEAL_KINDS] }),
  )
  kind: DecisionAppealKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The decision: a rejected permit, a rejected vehicle, a rejected worker’s engagement, a neighbour notice the unit received.',
  })
  @IsUUID()
  subjectId: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: DECISION_APPEAL_LIMITS.grounds,
  })
  @IsString()
  @Length(
    1,
    DECISION_APPEAL_LIMITS.grounds,
    withParams({ min: 1, max: DECISION_APPEAL_LIMITS.grounds }),
  )
  grounds: string;

  @ApiProperty({
    type: [String],
    required: false,
    maxItems: DECISION_APPEAL_LIMITS.attachments,
    description:
      'The caller’s uploads of purpose `decision_appeal_attachment` (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    DECISION_APPEAL_LIMITS.attachments,
    withParams({ max: DECISION_APPEAL_LIMITS.attachments }),
  )
  @IsUUID('all', { each: true })
  attachmentIds?: string[];
}

export class DecisionAppealsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: DECISION_APPEAL_STATUSES,
    enumName: 'DecisionAppealStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(
    DECISION_APPEAL_STATUSES,
    withParams({ allowed: [...DECISION_APPEAL_STATUSES] }),
  )
  status?: DecisionAppealStatus;
}

export class DecideDecisionAppealDto {
  @ApiProperty({
    enum: DECISION_APPEAL_OUTCOMES,
    enumName: 'DecisionAppealOutcome',
  })
  @IsIn(
    DECISION_APPEAL_OUTCOMES,
    withParams({ allowed: [...DECISION_APPEAL_OUTCOMES] }),
  )
  outcome: DecisionAppealOutcome;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: DECISION_APPEAL_LIMITS.rationale,
    description:
      'The reasoned decision, as the appellant and the unit’s primary will read it. Write no one’s name.',
  })
  @IsString()
  @Length(
    1,
    DECISION_APPEAL_LIMITS.rationale,
    withParams({ min: 1, max: DECISION_APPEAL_LIMITS.rationale }),
  )
  rationale: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: '^[A-Za-z0-9-]{1,20}$',
    description:
      'A vehicle overturned: the sticker its normal approval issues (`sticker_used` when issued before). Without it the overturn is left to follow up (`needs_sticker`).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,20}$/)
  stickerNumber?: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: LOCAL_DATE.source,
    description:
      'A vehicle overturned: its permit’s last local day, as its normal approval asks (`permit_date` when out of range).',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  permitValidUntil?: string;
}
