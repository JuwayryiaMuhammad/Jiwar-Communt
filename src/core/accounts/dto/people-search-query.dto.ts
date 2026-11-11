import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { PageQueryDto } from '../../common/http/list';
import { withParams } from '../../common/validation/validation-errors';

/**
 * A list of people (`GET /accounts`, `GET /residents`) that can be searched
 * (ADR 0072), so a picker finds anyone of a compound with more than a page
 * of them.
 */
export class PeopleSearchQueryDto extends PageQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: 2,
    maxLength: 64,
    description:
      'Part of the name, any case; or exactly the phone or the email. An erased account is never found.',
  })
  @IsOptional()
  @IsString()
  @Length(2, 64, withParams({ min: 2, max: 64 }))
  q?: string;
}
