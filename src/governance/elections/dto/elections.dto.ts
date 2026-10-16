import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
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
import { POLL_LIMITS } from '../../polls/poll-rules';
import {
  ELECTION_LIMITS,
  ELECTION_PHASES,
  type ElectionPhase,
} from '../election-rules';

const text = (max: number, description?: string) =>
  ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: 1,
    maxLength: max,
    description,
  });
const { seats, termMonths } = ELECTION_LIMITS;

class GovernanceElectionFieldsDto {
  @text(POLL_LIMITS.title, 'English, Arabic or both, each with its body.')
  @IsOptional()
  @IsString()
  titleEn?: string | null;

  @text(POLL_LIMITS.title)
  @IsOptional()
  @IsString()
  titleAr?: string | null;

  @text(POLL_LIMITS.body)
  @IsOptional()
  @IsString()
  bodyEn?: string | null;

  @text(POLL_LIMITS.body)
  @IsOptional()
  @IsString()
  bodyAr?: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description:
      'When nominations open: absent or past, now; at most 90 days ahead.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  nominationsOpenAt?: Date;
}

export class CreateGovernanceElectionDto extends GovernanceElectionFieldsDto {
  @ApiProperty({
    type: Number,
    minimum: seats.min,
    maximum: seats.max,
    description:
      'The seats to fill: each unit picks up to this many candidates. Fixed for good.',
  })
  @IsInt(withParams({ ...seats }))
  @Min(seats.min, withParams({ ...seats }))
  @Max(seats.max, withParams({ ...seats }))
  seats: number;

  @ApiProperty({
    type: Number,
    minimum: termMonths.min,
    maximum: termMonths.max,
    description: 'How long the elected board sits, from its certification.',
  })
  @IsInt(withParams({ ...termMonths }))
  @Min(termMonths.min, withParams({ ...termMonths }))
  @Max(termMonths.max, withParams({ ...termMonths }))
  termMonths: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When nominations close: 24 hours to 30 days after they open.',
  })
  @Type(() => Date)
  @IsDate()
  nominationsCloseAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When voting opens: from the close of nominations, at most 14 days later.',
  })
  @Type(() => Date)
  @IsDate()
  votingOpensAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When voting closes: 1 hour to 60 days after it opens.',
  })
  @Type(() => Date)
  @IsDate()
  votingClosesAt: Date;
}

/** What is absent stays; until nominations open, anything but the seats. */
export class UpdateGovernanceElectionDto extends GovernanceElectionFieldsDto {
  @ApiProperty({
    type: Number,
    required: false,
    minimum: termMonths.min,
    maximum: termMonths.max,
  })
  @IsOptional()
  @IsInt(withParams({ ...termMonths }))
  @Min(termMonths.min, withParams({ ...termMonths }))
  @Max(termMonths.max, withParams({ ...termMonths }))
  termMonths?: number;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  nominationsCloseAt?: Date;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  votingOpensAt?: Date;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  votingClosesAt?: Date;
}

export class CancelGovernanceElectionDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `governanceElectionCancel`.',
  })
  @IsString()
  reasonCode: string;
}

export class StandForElectionDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: ELECTION_LIMITS.statement,
    description:
      'A short statement to the owners, shown beside the name. Cleared if the account is erased.',
  })
  @IsOptional()
  @IsString()
  @Length(
    1,
    ELECTION_LIMITS.statement,
    withParams({ min: 1, max: ELECTION_LIMITS.statement }),
  )
  statement?: string;
}

export class DisqualifyCandidateDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `governanceCandidateDisqualify`.',
  })
  @IsString()
  reasonCode: string;
}

export class CastElectionVoteDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A unit whose vote the caller casts in this election (`myUnits`).',
  })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: seats.max,
    description: 'One to `seats` candidates, each once.',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: seats.max }))
  @ArrayMaxSize(seats.max, withParams({ min: 1, max: seats.max }))
  @IsUUID('all', { each: true })
  candidateIds: string[];
}

export class GovernanceElectionsQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    enum: ELECTION_PHASES,
    enumName: 'GovernanceElectionPhase',
  })
  @IsOptional()
  @IsIn(ELECTION_PHASES, withParams({ allowed: [...ELECTION_PHASES] }))
  phase?: ElectionPhase;
}
