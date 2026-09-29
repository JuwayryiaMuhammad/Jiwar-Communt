import {
  Body,
  Controller,
  HttpCode,
  Headers,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/guards/public.decorator';
import { resolveLocale } from '../common/i18n/locale';
import { OTP_REQUESTED_MESSAGE, AuthService } from './auth.service';
import {
  OtpRequestedView,
  OtpVerifiedView,
  RefreshTokenDto,
  RequestOtpDto,
  SelectAccountDto,
  TokensView,
  VerifyOtpDto,
} from './dto/auth.dto';

/**
 * Login: identifier → OTP by email → pick an account → tokens (ADR 0004).
 */
@ApiTags('auth')
@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Always answers the same way, whether or not the identifier exists. */
  @Post('otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @Ip() ip: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<OtpRequestedView> {
    // The account is not proven yet, so its stored locale is not used: the
    // email goes out in the language the requester's client asks for.
    await this.auth.requestOtp(
      dto.identifier,
      ip,
      resolveLocale(acceptLanguage),
    );
    return { code: 'OTP_REQUESTED', message: OTP_REQUESTED_MESSAGE };
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Ip() ip: string,
  ): Promise<OtpVerifiedView> {
    return this.auth.verifyOtp(dto.identifier, dto.code, ip);
  }

  @Post('select-account')
  @HttpCode(HttpStatus.OK)
  selectAccount(@Body() dto: SelectAccountDto): Promise<TokensView> {
    return this.auth.selectAccount(dto.loginTicket, dto.accountId);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto): Promise<TokensView> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}
