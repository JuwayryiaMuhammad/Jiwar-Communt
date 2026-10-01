import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

/** The token from the link's fragment (`/v#<token>`), sent in the body. */
export class VisitorTokenDto {
  @ApiProperty({
    type: String,
    description:
      'The fragment of the visitor link. Anything that is not a live link answers 404 VISITOR_PASS_NOT_FOUND.',
  })
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}
