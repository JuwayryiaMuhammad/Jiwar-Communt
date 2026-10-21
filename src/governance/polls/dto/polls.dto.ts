import { ApiProperty } from '@nestjs/swagger';
import { GovernancePollKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  CONTEST_STATUSES,
  type ContestStatus,
} from '../../contests/contest-rules';
import { POLL_LIMITS } from '../poll-rules';
import { ToInstant } from '../../../core/common/validation/instant';

const text = (max: number, description?: string) =>
  ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: 1,
    maxLength: max,
    description,
  });

export class GovernancePollOptionDto {
  @text(POLL_LIMITS.optionLabel, 'In the languages the poll is written in.')
  @IsOptional()
  @IsString()
  labelEn?: string | null;

  @text(POLL_LIMITS.optionLabel)
  @IsOptional()
  @IsString()
  labelAr?: string | null;
}

const { quorum, threshold } = POLL_LIMITS;

class GovernancePollFieldsDto {
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
    type: [GovernancePollOptionDto],
    required: false,
    description: `A \`choice\` poll's ${POLL_LIMITS.minOptions} to ${POLL_LIMITS.maxOptions} options, in the order shown. A \`yes_no\` poll takes none: its options are yes, no and abstain.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    POLL_LIMITS.maxOptions,
    withParams({ max: POLL_LIMITS.maxOptions }),
  )
  @ValidateNested({ each: true })
  @Type(() => GovernancePollOptionDto)
  options?: GovernancePollOptionDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description:
      'When voting opens: absent or past, now; at most 90 days ahead.',
  })
  @IsOptional()
  @ToInstant()
  @IsDate()
  opensAt?: Date;
}

export class CreateGovernancePollDto extends GovernancePollFieldsDto {
  @ApiProperty({ enum: GovernancePollKind, enumName: 'GovernancePollKind' })
  @IsEnum(GovernancePollKind)
  kind: GovernancePollKind;

  @ApiProperty({
    type: Boolean,
    description:
      'A secret ballot (no choice is ever stored with its unit) or an open vote (each unit’s choice is shown to the owners after the close). Fixed for good.',
  })
  @IsBoolean()
  secret: boolean;

  @ApiProperty({
    type: Number,
    minimum: quorum.min,
    maximum: quorum.max,
    description: 'The share of the electorate’s units that must vote, in %.',
  })
  @IsInt(withParams({ ...quorum }))
  @Min(quorum.min, withParams({ ...quorum }))
  @Max(quorum.max, withParams({ ...quorum }))
  quorumPct: number;

  @ApiProperty({
    type: Number,
    minimum: threshold.min,
    maximum: threshold.max,
    description:
      'The share of the votes that carries it, in %: of yes and no on a yes/no poll (abstentions left out), of all votes for the first option of a choice poll.',
  })
  @IsInt(withParams({ ...threshold }))
  @Min(threshold.min, withParams({ ...threshold }))
  @Max(threshold.max, withParams({ ...threshold }))
  thresholdPct: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When voting closes: 1 hour to 60 days after it opens (INVALID_VALUE, params.minHours and params.maxDays).',
  })
  @ToInstant()
  @IsDate()
  closesAt: Date;
}

/** What is absent stays; until voting opens, anything but its secrecy. */
export class UpdateGovernancePollDto extends GovernancePollFieldsDto {
  @ApiProperty({
    enum: GovernancePollKind,
    enumName: 'GovernancePollKind',
    required: false,
  })
  @IsOptional()
  @IsEnum(GovernancePollKind)
  kind?: GovernancePollKind;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: quorum.min,
    maximum: quorum.max,
  })
  @IsOptional()
  @IsInt(withParams({ ...quorum }))
  @Min(quorum.min, withParams({ ...quorum }))
  @Max(quorum.max, withParams({ ...quorum }))
  quorumPct?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: threshold.min,
    maximum: threshold.max,
  })
  @IsOptional()
  @IsInt(withParams({ ...threshold }))
  @Min(threshold.min, withParams({ ...threshold }))
  @Max(threshold.max, withParams({ ...threshold }))
  thresholdPct?: number;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @ToInstant()
  @IsDate()
  closesAt?: Date;
}

export class CancelGovernancePollDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `governancePollCancel`.',
  })
  @IsString()
  reasonCode: string;
}

export class CastPollVoteDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A unit whose vote the caller casts in this poll (`myUnits`); each votes once, for good.',
  })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: 1,
    description: 'The one option chosen (yes, no or abstain on a yes/no poll).',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: 1 }))
  @ArrayMaxSize(1, withParams({ min: 1, max: 1 }))
  @IsUUID('all', { each: true })
  optionIds: string[];
}

export class GovernancePollsQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    enum: CONTEST_STATUSES,
    enumName: 'GovernanceContestStatus',
  })
  @IsOptional()
  @IsIn(CONTEST_STATUSES, withParams({ allowed: [...CONTEST_STATUSES] }))
  status?: ContestStatus;
}
