import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { ApiArea, NoStore } from '../common/http/decorators';
import { Public } from '../common/guards/public.decorator';
import {
  ChangePasswordDto,
  PlatformLoginDto,
  PlatformRefreshDto,
} from './dto/platform.dto';
import { PlatformAuth } from './platform-auth.guard';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformTokensView } from './views/platform.views';

/** The platform owner's login (ADR 0011): email + password, never a tenant token. */
@ApiArea('platform', 'public')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  /** Every failure is the same INVALID_CREDENTIALS; a first login returns a `password_change` token. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: PlatformTokensView })
  async login(
    @Body() dto: PlatformLoginDto,
    @Ip() ip: string,
  ): Promise<PlatformTokensView> {
    return PlatformTokensView.from(
      await this.auth.login(dto.email, dto.password, ip),
    );
  }

  /** Revokes every platform session of the admin and starts a fresh one. */
  @PlatformAuth({ allowPasswordChange: true })
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: PlatformTokensView })
  async changePassword(
    @Body() dto: ChangePasswordDto,
  ): Promise<PlatformTokensView> {
    return PlatformTokensView.from(
      await this.auth.changePassword(dto.currentPassword, dto.newPassword),
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: PlatformTokensView })
  async refresh(@Body() dto: PlatformRefreshDto): Promise<PlatformTokensView> {
    return PlatformTokensView.from(await this.auth.refresh(dto.refreshToken));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async logout(@Body() dto: PlatformRefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}
