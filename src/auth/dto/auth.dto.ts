import { AccountType } from '@prisma/client';
import { IsString, IsUUID, Length, Matches } from 'class-validator';

export class RequestOtpDto {
  /** Email or phone (local Egyptian format or international). */
  @IsString()
  @Length(3, 254)
  identifier: string;
}

export class VerifyOtpDto {
  @IsString()
  @Length(3, 254)
  identifier: string;

  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class SelectAccountDto {
  @IsString()
  @Length(20, 200)
  loginTicket: string;

  @IsUUID()
  accountId: string;
}

export class RefreshTokenDto {
  @IsString()
  @Length(20, 200)
  refreshToken: string;
}

export class OtpRequestedView {
  message: string;
}

export class LoginAccountView {
  accountId: string;
  tenantName: string;
  accountType: AccountType;
}

export class OtpVerifiedView {
  /** Single use, short-lived. Exchange it with POST /auth/select-account. */
  loginTicket: string;
  accounts: LoginAccountView[];
}

export class TokensView {
  accessToken: string;
  /** seconds */
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  accountId: string;
  accountType: AccountType;
}
