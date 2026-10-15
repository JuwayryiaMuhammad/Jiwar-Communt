import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { StepUpService } from '../../core/auth/step-up.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea } from '../../core/common/http/decorators';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { SetGatewayDto, SetOnlinePaymentDto } from './dto/gateway.dto';
import { GatewayService } from './gateway.service';
import { GatewayView } from './views/gateway.view';

/**
 * The compound's online payment account, from its manager's side
 * (ADR 0046). Changing it spends a step-up (`POST /me/step-up`).
 */
@ApiArea('finance')
@RequirePermissions('finance.gateway')
@Controller('staff/finance/gateway')
export class GatewayController {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly gateway: GatewayService,
    private readonly stepUp: StepUpService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The compound's online payment account, masked" })
  @ApiOkResponse({ type: GatewayView })
  get(): Promise<GatewayView> {
    return this.tenantTx.withTenantTx((tx) =>
      this.gateway.view(tx, this.ctx.tenantId),
    );
  }

  /** Every credential at once; spends the session's step-up. */
  @Put()
  @ApiOperation({
    summary: "Set the compound's Paymob credentials (step-up required)",
  })
  @ApiOkResponse({ type: GatewayView })
  set(@Body() dto: SetGatewayDto): Promise<GatewayView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.stepUp.consume(tx);
      await this.gateway.set(tx, this.ctx.tenantId, dto, {
        accountId: this.ctx.accountId,
      });
      return this.gateway.view(tx, this.ctx.tenantId);
    });
  }

  @Patch()
  @ApiOperation({
    summary: 'Turn online payment on or off (step-up required)',
  })
  @ApiOkResponse({ type: GatewayView })
  toggle(@Body() dto: SetOnlinePaymentDto): Promise<GatewayView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.stepUp.consume(tx);
      await this.gateway.setOnline(tx, this.ctx.tenantId, dto.onlineEnabled);
      return this.gateway.view(tx, this.ctx.tenantId);
    });
  }
}
