import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { DispatchSettingsService } from './dispatch-settings.service';
import { UpdateDispatchSettingsDto } from './dto/dispatch-settings.dto';
import { DispatchSettingsResponse } from './views/dispatch-settings.views';

/** The compound's dispatch settings (ADR 0033). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/dispatch-settings')
export class DispatchSettingsController {
  constructor(private readonly settings: DispatchSettingsService) {}

  @Get()
  @ApiOkResponse({ type: DispatchSettingsResponse })
  async get(): Promise<DispatchSettingsResponse> {
    return DispatchSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @ApiOkResponse({ type: DispatchSettingsResponse })
  async update(
    @Body() dto: UpdateDispatchSettingsDto,
  ): Promise<DispatchSettingsResponse> {
    return DispatchSettingsResponse.from(await this.settings.update(dto));
  }
}
