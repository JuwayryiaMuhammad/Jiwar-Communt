import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { AudienceDto } from '../../audience/audience';
import {
  OPTION_LABEL_MAX,
  OPTIONS,
  POLL_STATUSES,
  QUESTION_MAX,
  type PollStatus,
} from '../poll-rules';

const text = (max: number, description?: string) =>
  ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: 1,
    maxLength: max,
    description,
  });

export class PollOptionDto {
  @text(OPTION_LABEL_MAX, 'In the languages the question is written in.')
  @IsOptional()
  @IsString()
  labelEn?: string | null;

  @text(OPTION_LABEL_MAX)
  @IsOptional()
  @IsString()
  labelAr?: string | null;
}

class PollContentDto {
  @text(QUESTION_MAX, 'English, Arabic or both; at least one.')
  @IsOptional()
  @IsString()
  questionEn?: string | null;

  @text(QUESTION_MAX)
  @IsOptional()
  @IsString()
  questionAr?: string | null;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Several options may be chosen. Absent: one.',
  })
  @IsOptional()
  @IsBoolean()
  multiple?: boolean;

  @ApiProperty({
    type: AudienceDto,
    required: false,
    description:
      'Whose units vote. Absent: the whole compound, everyone. A poll put to the `owners` is voted by a unit’s owner; any other by its primary occupant or a member given `polls_vote`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceDto)
  audience?: AudienceDto;
}

export class CreatePollDto extends PollContentDto {
  @ApiProperty({
    type: [PollOptionDto],
    minItems: OPTIONS.min,
    maxItems: OPTIONS.max,
    description: 'In the order shown.',
  })
  @IsArray()
  @ArrayMinSize(OPTIONS.min, withParams({ ...OPTIONS }))
  @ArrayMaxSize(OPTIONS.max, withParams({ ...OPTIONS }))
  @ValidateNested({ each: true })
  @Type(() => PollOptionDto)
  options: PollOptionDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'When voting opens. Absent: now.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  opensAt?: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When voting closes, by itself. After the opening, and ahead.',
  })
  @Type(() => Date)
  @IsDate()
  closesAt: Date;
}

/**
 * What is absent stays. Before it opens, anything may change; once open,
 * only the closing time.
 */
export class UpdatePollDto extends PollContentDto {
  @ApiProperty({
    type: [PollOptionDto],
    required: false,
    minItems: OPTIONS.min,
    maxItems: OPTIONS.max,
    description: 'Replaces the options as a whole.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(OPTIONS.min, withParams({ ...OPTIONS }))
  @ArrayMaxSize(OPTIONS.max, withParams({ ...OPTIONS }))
  @ValidateNested({ each: true })
  @Type(() => PollOptionDto)
  options?: PollOptionDto[];

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  opensAt?: Date;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  closesAt?: Date;
}

export class CastVoteDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'The unit whose vote this is. Required only when the caller casts the vote of several units in this poll.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: OPTIONS.max,
    description:
      'The unit’s choice from now on: one option, or several when the poll allows it. Replaces an earlier choice.',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: OPTIONS.max }))
  @ArrayMaxSize(OPTIONS.max, withParams({ min: 1, max: OPTIONS.max }))
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  optionIds: string[];
}

export class PollsQueryDto extends PageQueryDto {
  @ApiProperty({ enum: POLL_STATUSES, required: false })
  @IsOptional()
  @IsIn([...POLL_STATUSES], withParams({ allowed: [...POLL_STATUSES] }))
  status?: PollStatus;
}
