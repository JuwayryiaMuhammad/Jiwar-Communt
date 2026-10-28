import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { IdentityDocumentDto } from '../../../core/common/http/identity-document.dto';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PROXY_SCOPES } from '../../capabilities/capabilities';

/** A proxy an owner appoints (ADR 0063); the code goes to this email only. */
export class NewProxyDto extends IdentityDocumentDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;

  @ApiProperty({ type: String })
  @IsPhone()
  phone: string;

  @ApiProperty({
    enum: PROXY_SCOPES,
    isArray: true,
    minItems: 1,
    maxItems: 5,
    description:
      'What the proxy may do while the unit is closed or has no primary.',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1 }))
  @ArrayMaxSize(5, withParams({ max: 5 }))
  @IsIn([...PROXY_SCOPES], {
    each: true,
    ...withParams({ allowed: [...PROXY_SCOPES] }),
  })
  scopes: string[];

  @ApiProperty({
    type: String,
    format: 'date',
    description:
      'Its last day (the compound’s calendar), a year ahead at most.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, withParams({ format: 'YYYY-MM-DD' }))
  endsOn: string;
}

export class ProxyTokenDto {
  @ApiProperty({
    type: String,
    description: 'The token from the proxy invitation link.',
  })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  token: string;
}

export class CompleteProxyDto extends ProxyTokenDto {
  @ApiProperty({ type: String, pattern: '^\\d{6}$' })
  @Matches(/^\d{6}$/, withParams({ length: 6 }))
  code: string;
}
