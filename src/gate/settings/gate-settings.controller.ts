import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { UpdateGateSettingsDto } from './dto/gate-settings.dto';
import { GateSettingsService } from './gate-settings.service';
import { GateSettingsResponse } from './views/gate-settings.views';

/** The gate's settings, as the management sets them (ADR 0056). */
@ApiArea('gate')
@RequirePermissions('gate.manage')
@Controller('staff/gate/settings')
export class GateSettingsController {
  constructor(private readonly settings: GateSettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the gate’s settings' })
  @ApiOkResponse({ type: GateSettingsResponse })
  async get(): Promise<GateSettingsResponse> {
    return GateSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({
    summary: 'Change the gate’s settings',
    description:
      'What is left out stays. A field exception already raised or approved keeps the deadlines written on it.',
  })
  @ApiOkResponse({ type: GateSettingsResponse })
  async update(
    @Body() dto: UpdateGateSettingsDto,
  ): Promise<GateSettingsResponse> {
    return GateSettingsResponse.from(await this.settings.update(dto));
  }
}
