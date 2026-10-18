import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

/** The token from the pickup link's fragment (`/c#<token>`), sent in the body. */
export class PickupTokenDto {
  @ApiProperty({
    type: String,
    description:
      'The fragment of the pickup link. Anything that is not a live link answers 404 CHILD_PICKUP_NOT_FOUND.',
  })
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}
