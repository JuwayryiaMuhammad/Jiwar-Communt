import {
  Body,
  Controller,
  HttpCode,
  Ip,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../core/common/guards/public.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { PaymobWebhookService } from './paymob-webhook.service';

/**
 * Paymob's transaction-processed callback (ADR 0046), per compound. Public:
 * the HMAC is what authenticates it. 401 refused (the same answer whatever
 * the reason), 200 handled (a no-op included), 500 when Paymob should call
 * again. The body stays a plain object: Paymob decides its fields.
 */
@ApiArea('public', 'public')
@Public()
@Controller('public/payments/paymob')
export class PaymobWebhookController {
  constructor(private readonly webhook: PaymobWebhookService) {}

  @Post(':compoundId')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async callback(
    @Param('compoundId') compoundId: string,
    @Query('hmac') hmac: unknown,
    @Body() body: Record<string, unknown>,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: boolean }> {
    const answer = await this.webhook.handle(compoundId, hmac, body, ip);
    res.status(answer.status);
    return { ok: answer.status === 200 };
  }
}
