import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { ApiArea } from '../common/http/decorators';
import { StepUpCodeDto, StepUpView } from './dto/step-up.dto';
import { StepUpService } from './step-up.service';

/**
 * Step-up (ADR 0036): a fresh code to the account's own email, bound to
 * this session, before a sensitive action. Any signed-in tenant account.
 */
@ApiArea('security')
@Controller('me/step-up')
export class StepUpController {
  constructor(private readonly stepUp: StepUpService) {}

  @Post()
  @ApiOperation({ summary: 'Email me a step-up code for a sensitive action' })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse()
  async request(): Promise<void> {
    await this.stepUp.request();
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify the step-up code on this session' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: StepUpView })
  async verify(@Body() dto: StepUpCodeDto): Promise<StepUpView> {
    return { expiresAt: await this.stepUp.verify(dto.code) };
  }
}
