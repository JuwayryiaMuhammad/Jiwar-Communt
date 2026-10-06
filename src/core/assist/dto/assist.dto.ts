import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import {
  GrantConsentDto,
  RevokeConsentDto,
} from '../../consents/dto/consents.dto';
import { UpdatePreferencesDto } from '../../preferences/dto/preferences.dto';

const REASON = {
  type: String,
  description:
    'How the person asked: `in_person`, `phone_call` or `written_request` (INVALID_REASON_CODE otherwise).',
} as const;

/** `{ reasonCode }`: how the person asked the management to act for them. */
export class AssistReasonDto {
  @ApiProperty(REASON)
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class AssistPreferencesDto extends UpdatePreferencesDto {
  @ApiProperty(REASON)
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class AssistGrantDto extends GrantConsentDto {
  @ApiProperty(REASON)
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class AssistRevokeDto extends RevokeConsentDto {
  @ApiProperty(REASON)
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
