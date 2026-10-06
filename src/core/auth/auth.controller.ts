import {
  Body,
  Controller,
  HttpCode,
  Headers,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { ApiArea, NoStore } from '../common/http/decorators';
import { Public } from '../common/guards/public.decorator';
import { resolveLocale } from '../common/i18n/locale';
import { OTP_REQUESTED_MESSAGE, AuthService } from './auth.service';
import { INSTALL_ID_HEADER } from './devices';
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
@ApiArea('auth', 'public')
@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Always answers the same way, whether or not the identifier exists. */
  @Post('otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: OtpRequestedView })
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
  @NoStore()
  @ApiOkResponse({ type: OtpVerifiedView })
  verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Ip() ip: string,
  ): Promise<OtpVerifiedView> {
    return this.auth.verifyOtp(dto.identifier, dto.code, ip);
  }

  @Post('select-account')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: TokensView })
  @ApiHeader({
    name: INSTALL_ID_HEADER,
    required: false,
    description:
      'The app sends the UUID it made at install: a login from a device never seen on the account raises an alert (ADR 0036). Browsers send none.',
  })
  selectAccount(
    @Body() dto: SelectAccountDto,
    @Headers('user-agent') userAgent?: string,
    @Headers(INSTALL_ID_HEADER) installId?: string,
  ): Promise<TokensView> {
    return this.auth.selectAccount(dto.loginTicket, dto.accountId, {
      userAgent,
      installId,
    });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: TokensView })
  refresh(@Body() dto: RefreshTokenDto): Promise<TokensView> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}
