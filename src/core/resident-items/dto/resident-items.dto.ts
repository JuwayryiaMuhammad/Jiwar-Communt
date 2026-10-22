import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../common/http/list';
import { withParams } from '../../common/validation/validation-errors';

const STATES = ['open', 'closed'] as const;

export class ResidentItemsQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    enum: STATES,
    description:
      '`open`: still going; `closed`: finished (the archive). Both by default.',
  })
  @IsOptional()
  @IsIn(STATES, withParams({ allowed: [...STATES] }))
  state?: (typeof STATES)[number];
}

export const SEARCH_LENGTH = { min: 2, max: 64 } as const;

export class ResidentSearchQueryDto {
  @ApiProperty({
    type: String,
    minLength: SEARCH_LENGTH.min,
    maxLength: SEARCH_LENGTH.max,
    description:
      'A reference (`MT-000123`, `mt123`, `123`) or words of a name the compound wrote (a category, a topic, a facility).',
  })
  @IsString()
  @Length(
    SEARCH_LENGTH.min,
    SEARCH_LENGTH.max,
    withParams({ ...SEARCH_LENGTH }),
  )
  // No LIKE wildcards: what is typed is matched as typed.
  @Matches(/^[^%_\\]*$/)
  q: string;
}
