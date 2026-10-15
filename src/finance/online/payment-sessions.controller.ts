import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { OpenPaymentSessionDto } from './dto/payment-sessions.dto';
import { PaymentSessionsService } from './payment-sessions.service';
import { PaymentSessionView } from './views/payment-session.views';

/**
 * Paying online (ADR 0046), for whoever may pay the unit's money
 * (capabilities.financePay, within a member's cap per operation).
 */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class PaymentSessionsController {
  constructor(private readonly sessions: PaymentSessionsService) {}

  @Post('units/:unitId/payment-sessions')
  @NoStore()
  @ApiOperation({
    summary: 'Open (or reuse) a checkout for some or all of what the unit owes',
    description:
      'Returns the hosted Paymob page. The unit has one live checkout; the same basket by the same payer reuses it. Poll GET /payment-sessions/{id} afterwards: the return page proves nothing.',
  })
  @Idempotent({ secret: true })
  @ApiCreatedResponse({ type: PaymentSessionView })
  open(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: OpenPaymentSessionDto,
  ): Promise<PaymentSessionView> {
    return this.sessions.open(unitId, dto);
  }

  @Get('payment-sessions/:id')
  @NoStore()
  @ApiOperation({ summary: 'Where a checkout stands' })
  @ApiOkResponse({ type: PaymentSessionView })
  status(@Param('id', parseId()) id: string): Promise<PaymentSessionView> {
    return this.sessions.status(id);
  }
}
