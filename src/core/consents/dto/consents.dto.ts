import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Min } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';
import { CONSENT_CODES, type ConsentCode } from '../consent-catalog';

export class RevokeConsentDto {
  @ApiProperty({ enum: [...CONSENT_CODES], enumName: 'ConsentCode' })
  @IsIn(CONSENT_CODES, withParams({ allowed: [...CONSENT_CODES] }))
  code: ConsentCode;
}

export class GrantConsentDto extends RevokeConsentDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    description:
      'The version of the text the account agreed to: it must be the current one (CONSENT_VERSION_MISMATCH).',
  })
  @IsInt(withParams({ min: 1 }))
  @Min(1, withParams({ min: 1 }))
  version: number;
}
