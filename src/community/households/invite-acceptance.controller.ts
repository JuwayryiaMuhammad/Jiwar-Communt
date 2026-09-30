import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse } from '@nestjs/swagger';
import { ApiArea } from '../../core/common/http/decorators';
import { Public } from '../../core/common/guards/public.decorator';
import { resolveLocale } from '../../core/common/i18n/locale';
import { CompleteInviteDto, InviteTokenDto } from './dto/invite-acceptance.dto';
import { InviteAcceptanceService } from './invite-acceptance.service';
import {
  INVITE_CODE_REQUESTED,
  InviteAcceptedView,
  InviteCodeRequestedView,
} from './views/invite-acceptance.views';

/**
 * Accepting a household invite (ADR 0016), before the invitee has an
 * account. Rate-limited; the answers never tell a valid token from an
 * invalid one.
 */
@ApiArea('public', 'public')
@Public()
@Controller('invites/accept')
export class InviteAcceptanceController {
  constructor(private readonly acceptance: InviteAcceptanceService) {}

  /** The code goes to the invited email, and only to it. */
  @Post('start')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: InviteCodeRequestedView })
  async start(
    @Body() dto: InviteTokenDto,
    @Ip() ip: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<InviteCodeRequestedView> {
    await this.acceptance.startAcceptance(
      dto.token,
      ip,
      resolveLocale(acceptLanguage),
    );
    return INVITE_CODE_REQUESTED;
  }

  /** Every failure is the same 401 OTP_INVALID. */
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: InviteAcceptedView })
  async complete(
    @Body() dto: CompleteInviteDto,
    @Ip() ip: string,
  ): Promise<InviteAcceptedView> {
    return InviteAcceptedView.from(
      await this.acceptance.completeAcceptance(dto.token, dto.code, ip),
    );
  }
}
