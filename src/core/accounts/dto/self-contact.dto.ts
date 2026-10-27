import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';
import { IDENTITY_FIELDS } from '../identity-changes.service';

/** The new email; a code goes there (ADR 0062). */
export class NewEmailDto {
  @ApiProperty({ type: String, maxLength: 254 })
  @IsString()
  @Length(3, 254, withParams({ min: 3, max: 254 }))
  email: string;
}

export class VerifyNewEmailDto extends NewEmailDto {
  @ApiProperty({
    type: String,
    description: 'The 6 digits sent to the new email.',
  })
  @IsString()
  @Matches(/^\d{6}$/, withParams({ length: 6 }))
  code: string;
}

/** A name or a phone the management will decide on. */
export class NewIdentityChangeDto {
  @ApiProperty({ enum: IDENTITY_FIELDS })
  @IsIn([...IDENTITY_FIELDS], withParams({ allowed: [...IDENTITY_FIELDS] }))
  field: 'name' | 'phone';

  @ApiProperty({
    type: String,
    description: 'The full name (2 to 200 characters) or the phone number.',
  })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  value: string;
}
