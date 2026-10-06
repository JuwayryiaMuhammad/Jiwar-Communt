import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

/** The fragment of the assisted email's link (`/a/export#<token>`). */
export class ExportLinkDto {
  @ApiProperty({
    type: String,
    description:
      'Anything that is not a live link answers 404 ACTION_TOKEN_INVALID.',
  })
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}

export class ExportDownloadDto extends ExportLinkDto {
  @ApiProperty({
    type: String,
    pattern: '^\\d{6}$',
    description: 'The code sent to the account’s email for this link.',
  })
  @Matches(/^\d{6}$/, {
    message: 'code must be 6 digits',
    ...withParams({ length: 6 }),
  })
  code: string;
}
