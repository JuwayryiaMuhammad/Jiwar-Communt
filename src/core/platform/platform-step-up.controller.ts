import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { StepUpCodeDto, StepUpView } from '../auth/dto/step-up.dto';
import { ApiArea } from '../common/http/decorators';
import { PlatformAuth } from './platform-auth.guard';
import { PlatformStepUpService } from './platform-step-up.service';

/**
 * Platform step-up (ADR 0046): a fresh code to the admin's own email, bound
 * to this platform session, before a sensitive action.
 */
@ApiArea('platform', 'platform')
@PlatformAuth()
@Controller('platform/step-up')
export class PlatformStepUpController {
  constructor(private readonly stepUp: PlatformStepUpService) {}

  @Post()
  @ApiOperation({ summary: 'Email me a step-up code for a sensitive action' })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse()
  async request(): Promise<void> {
    await this.stepUp.request();
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify the step-up code on this platform session' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: StepUpView })
  async verify(@Body() dto: StepUpCodeDto): Promise<StepUpView> {
    return { expiresAt: await this.stepUp.verify(dto.code) };
  }
}
