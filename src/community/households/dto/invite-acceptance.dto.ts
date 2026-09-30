import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

export class InviteTokenDto {
  @ApiProperty({
    type: String,
    description: 'The token from the invitation link.',
  })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  token: string;
}

export class CompleteInviteDto extends InviteTokenDto {
  @ApiProperty({ type: String, pattern: '^\\\\d{6}$' })
  @Matches(/^\d{6}$/, withParams({ length: 6 }))
  code: string;
}
