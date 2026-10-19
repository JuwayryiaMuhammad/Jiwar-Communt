import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { DeviceEnvelopeDto } from './dto/device-envelope.dto';
import { GateBundlesService } from './gate-bundles.service';
import {
  BundleKeysResponse,
  GateBundleResponse,
} from './views/gate-bundle.views';

/** The gate bundle a device downloads to work offline (ADR 0057). */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate/offline')
export class GateBundlesController {
  constructor(private readonly bundles: GateBundlesService) {}

  @Get('keys')
  @NoStore()
  @ApiOperation({
    summary: 'The keys gate bundles are signed with',
    description:
      'The current one and any retired one a live bundle may carry (a day after a rotation).',
  })
  @ApiOkResponse({ type: BundleKeysResponse })
  async keys(): Promise<BundleKeysResponse> {
    return BundleKeysResponse.from(await this.bundles.keys());
  }

  @Post('bundles')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Download the gate bundle for this device, shift and gate',
    description:
      'A signed envelope (`purpose: bundle`), inside a shift at a gate. Valid until the shift’s planned end, a day at most; numbered per device. A revoked device is GATE_DEVICE_REVOKED; the same envelope twice is GATE_DEVICE_ENVELOPE_REPLAYED.',
  })
  @ApiOkResponse({ type: GateBundleResponse })
  async issue(@Body() dto: DeviceEnvelopeDto): Promise<GateBundleResponse> {
    return GateBundleResponse.from(await this.bundles.issue(dto));
  }
}
