import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Put,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { SlaTargetsDto, UpdateSlaSettingsDto } from './dto/sla.dto';
import { SlaSettingsService } from './sla-settings.service';
import { SlaSweep } from './sla-sweep';
import { SlaTargetsService } from './sla-targets.service';
import { SlaSettingsResponse } from './views/sla.views';

/** The compound's SLA switch (ADR 0034). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/sla-settings')
export class SlaSettingsController {
  private readonly logger = new Logger(SlaSettingsController.name);

  constructor(
    private readonly settings: SlaSettingsService,
    private readonly sweep: SlaSweep,
  ) {}

  @Get()
  @ApiOkResponse({ type: SlaSettingsResponse })
  async get(): Promise<SlaSettingsResponse> {
    return SlaSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @ApiOkResponse({ type: SlaSettingsResponse })
  async update(
    @Body() dto: UpdateSlaSettingsDto,
  ): Promise<SlaSettingsResponse> {
    const updated = await this.settings.update(dto);
    // Turned on or off: the open tickets' clocks are started or stopped
    // after the switch committed, ticket by ticket in bounded batches. The
    // answer does not wait; the sweep finishes what the pass leaves, and a
    // ticket written meanwhile starts its own clocks under its lock.
    if (updated.turnedOn || updated.turnedOff)
      this.sweep
        .pass()
        .catch((error: unknown) =>
          this.logger.error(
            `SLA pass failed (${error instanceof Error ? error.name : 'Error'})`,
          ),
        );
    return SlaSettingsResponse.from(updated);
  }
}

/** A category's SLA targets: the manager's (ADR 0034). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/categories')
export class CategorySlaTargetsController {
  constructor(private readonly targets: SlaTargetsService) {}

  /** All three priorities at once; running clocks keep their target. */
  @Put(':id/sla-targets')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  set(
    @Param('id', parseId()) id: string,
    @Body() dto: SlaTargetsDto,
  ): Promise<void> {
    return this.targets.replace(id, dto);
  }
}
