import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiAcceptedResponse } from '@nestjs/swagger';
import { ApiArea } from '../../core/common/http/decorators';
import { Public } from '../../core/common/guards/public.decorator';
import { resolveLocale } from '../../core/common/i18n/locale';
import {
  CompleteRegistrationDto,
  RegistrationRequestDto,
} from './dto/registration.dto';
import { RegistrationService } from './registration.service';
import {
  RegistrationCodeSentView,
  RegistrationReceivedView,
} from './views/registration-public.views';

/**
 * Resident self-registration (ADR 0024): a request, never an account. The
 * same body and status for every input that has the right shape.
 */
@ApiArea('public', 'public')
@Public()
@Controller('registrations')
export class RegistrationPublicController {
  constructor(private readonly registrations: RegistrationService) {}

  @Post('start')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: RegistrationCodeSentView })
  start(
    @Body() dto: RegistrationRequestDto,
    @Ip() ip: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<RegistrationCodeSentView> {
    return this.registrations.start(dto, ip, resolveLocale(acceptLanguage));
  }

  /** A wrong code is 401 OTP_INVALID; everything else is REGISTRATION_RECEIVED. */
  @Post('complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: RegistrationReceivedView })
  complete(
    @Body() dto: CompleteRegistrationDto,
    @Ip() ip: string,
  ): Promise<RegistrationReceivedView> {
    const { code, ...request } = dto;
    return this.registrations.complete(request, code, ip);
  }
}
