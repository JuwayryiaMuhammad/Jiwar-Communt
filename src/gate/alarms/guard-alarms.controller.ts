import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Ip,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../core/common/guards/public.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { GuardAlarmsService } from './guard-alarms.service';

/**
 * The guard-down vendor's calls (ADR 0068), per compound. Public: the
 * driver's signature check authenticates them. 200 handled (a replay
 * included), 401 refused (the same whatever the reason), 404 off, 500 call
 * again.
 */
@ApiArea('public', 'public')
@Public()
@Controller('public/gate/alarms')
export class GuardAlarmsWebhookController {
  constructor(private readonly alarms: GuardAlarmsService) {}

  @Post(':compoundId')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(
    @Param('compoundId') compoundId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: boolean }> {
    const answer = await this.alarms.receive(compoundId, headers, body, ip);
    res.status(answer.status);
    return { ok: answer.status === 200 };
  }
}
