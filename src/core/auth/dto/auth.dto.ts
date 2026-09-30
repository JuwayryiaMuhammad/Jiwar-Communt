import { ApiProperty } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import { IsString, IsUUID, Length, Matches } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

export class RequestOtpDto {
  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 254,
    description: 'Email or phone (local Egyptian format or international).',
  })
  @IsString()
  @Length(3, 254, withParams({ min: 3, max: 254 }))
  identifier: string;
}

export class VerifyOtpDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 254 })
  @IsString()
  @Length(3, 254, withParams({ min: 3, max: 254 }))
  identifier: string;

  @ApiProperty({ type: String, pattern: '^\\d{6}$' })
  @Matches(/^\d{6}$/, {
    message: 'code must be 6 digits',
    ...withParams({ length: 6 }),
  })
  code: string;
}

export class SelectAccountDto {
  @ApiProperty({ type: String, minLength: 20, maxLength: 200 })
  @IsString()
  @Length(20, 200, withParams({ min: 20, max: 200 }))
  loginTicket: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  accountId: string;
}

export class RefreshTokenDto {
  @ApiProperty({ type: String, minLength: 20, maxLength: 200 })
  @IsString()
  @Length(20, 200, withParams({ min: 20, max: 200 }))
  refreshToken: string;
}

export class OtpRequestedView {
  @ApiProperty({
    enum: ['OTP_REQUESTED'],
    description: 'Stable key for the frontend to translate.',
  })
  code: 'OTP_REQUESTED';
  @ApiProperty({ type: String, description: 'English, for developers only.' })
  message: string;
}

export class LoginAccountView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String })
  tenantName: string;
  @ApiProperty({ enum: AccountType, enumName: 'AccountType' })
  accountType: AccountType;
}

export class OtpVerifiedView {
  @ApiProperty({
    type: String,
    description:
      'Single use, short-lived. Exchange it with POST /auth/select-account.',
  })
  loginTicket: string;
  @ApiProperty({ type: [LoginAccountView] })
  accounts: LoginAccountView[];
}

export class TokensView {
  @ApiProperty({ type: String })
  accessToken: string;
  @ApiProperty({ type: Number, description: 'seconds' })
  accessTokenExpiresIn: number;
  @ApiProperty({ type: String })
  refreshToken: string;
  @ApiProperty({ type: String, format: 'date-time' })
  refreshTokenExpiresAt: Date;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ enum: AccountType, enumName: 'AccountType' })
  accountType: AccountType;
}
