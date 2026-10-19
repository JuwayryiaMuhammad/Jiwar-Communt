import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { APPROVAL_LIMITS } from '../../approvals/approval-rules';

const L = APPROVAL_LIMITS;
export const APPROVAL_OUTCOMES = ['approve', 'reject'] as const;
export const VOTE_CHOICES = ['for', 'against'] as const;

class MotionReasons {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: L.rationale,
    description:
      'The board’s reasons, as they will stand with the decision. Write no one’s name: they are kept with the record.',
  })
  @IsString()
  @Length(1, L.rationale, withParams({ min: 1, max: L.rationale }))
  rationale: string;
}

export class ProposeApprovalMotionDto extends MotionReasons {
  @ApiProperty({ enum: APPROVAL_OUTCOMES, enumName: 'ApprovalMotionOutcome' })
  @IsIn(APPROVAL_OUTCOMES, withParams({ allowed: [...APPROVAL_OUTCOMES] }))
  outcome: (typeof APPROVAL_OUTCOMES)[number];

  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: L.alternativesNote,
    description: 'Why the package’s alternatives were not taken.',
  })
  @IsOptional()
  @IsString()
  @Length(
    1,
    L.alternativesNote,
    withParams({ min: 1, max: L.alternativesNote }),
  )
  alternativesNote?: string;
}

export class BoardVoteDto {
  @ApiProperty({ enum: VOTE_CHOICES, enumName: 'BoardVoteChoice' })
  @IsIn(VOTE_CHOICES, withParams({ allowed: [...VOTE_CHOICES] }))
  choice: (typeof VOTE_CHOICES)[number];
}
