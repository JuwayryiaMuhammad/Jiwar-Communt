import { Body, Controller, Get, Param, Patch, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { PlatformAuth } from '../../core/platform/platform-auth.guard';
import { SetGatewayDto, SetPlatformDisabledDto } from './dto/gateway.dto';
import { PlatformGatewayService } from './platform-gateway.service';
import { GatewayView } from './views/gateway.view';

/**
 * Any compound's online payment account, from the platform owner's side
 * (ADR 0046). Changing it spends a platform step-up
 * (`POST /platform/step-up`).
 */
@ApiArea('platform', 'platform')
@PlatformAuth()
@Controller('platform/tenants/:id/payment-gateway')
export class PlatformGatewayController {
  constructor(private readonly gateways: PlatformGatewayService) {}

  @Get()
  @ApiOperation({ summary: "A compound's online payment account, masked" })
  @ApiOkResponse({ type: GatewayView })
  get(@Param('id', parseId()) id: string): Promise<GatewayView> {
    return this.gateways.view(id);
  }

  @Put()
  @ApiOperation({
    summary: "Set a compound's Paymob credentials (platform step-up required)",
  })
  @ApiOkResponse({ type: GatewayView })
  set(
    @Param('id', parseId()) id: string,
    @Body() dto: SetGatewayDto,
  ): Promise<GatewayView> {
    return this.gateways.set(id, dto);
  }

  @Patch()
  @ApiOperation({
    summary:
      "Switch a compound's online payment off or back (platform step-up required)",
  })
  @ApiOkResponse({ type: GatewayView })
  toggle(
    @Param('id', parseId()) id: string,
    @Body() dto: SetPlatformDisabledDto,
  ): Promise<GatewayView> {
    return this.gateways.setDisabled(id, dto.platformDisabled);
  }
}
