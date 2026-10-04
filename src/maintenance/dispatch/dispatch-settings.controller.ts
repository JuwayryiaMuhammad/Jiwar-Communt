import { Body, Controller, Get, Logger, Patch } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { DispatchSweep } from './dispatch-sweep';
import { DispatchSettingsService } from './dispatch-settings.service';
import { UpdateDispatchSettingsDto } from './dto/dispatch-settings.dto';
import { DispatchSettingsResponse } from './views/dispatch-settings.views';

/** The compound's dispatch settings (ADR 0033). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/dispatch-settings')
export class DispatchSettingsController {
  private readonly logger = new Logger(DispatchSettingsController.name);

  constructor(
    private readonly settings: DispatchSettingsService,
    private readonly sweep: DispatchSweep,
  ) {}

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
    const updated = await this.settings.update(dto);
    // Turned on: a bounded pass over the queue starts now, after the change
    // committed, so enabling has a visible effect without waiting for the
    // sweep. The answer does not wait for it; each ticket is its own
    // transaction and a failure only leaves the ticket to the sweep.
    if (updated.turnedOn)
      this.sweep
        .drain()
        .catch((error: unknown) =>
          this.logger.error(
            `dispatch drain failed (${error instanceof Error ? error.name : 'Error'})`,
          ),
        );
    return DispatchSettingsResponse.from(updated);
  }
}
