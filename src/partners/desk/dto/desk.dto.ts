import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  AcceptPartnerRequestDto,
  DeclinePartnerRequestDto,
  PartnerCancelPartnerRequestDto,
  ProposePartnerRequestDto,
} from '../../requests/dto/requests.dto';

const TOKEN = {
  type: String,
  description:
    'The fragment of the desk link (`/p#<token>`). Anything that is not a live link answers 404 PARTNER_DESK_NOT_FOUND.',
} as const;

/** The token from the desk link's fragment, sent in the body. */
export class DeskTokenDto {
  @ApiProperty(TOKEN)
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}

export class DeskAcceptDto extends AcceptPartnerRequestDto {
  @ApiProperty(TOKEN)
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}

export class DeskDeclineDto extends DeclinePartnerRequestDto {
  @ApiProperty(TOKEN)
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}

export class DeskProposeDto extends ProposePartnerRequestDto {
  @ApiProperty(TOKEN)
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}

export class DeskCancelDto extends PartnerCancelPartnerRequestDto {
  @ApiProperty(TOKEN)
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}
