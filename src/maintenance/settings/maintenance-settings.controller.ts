import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { UpdateMaintenanceSettingsDto } from './dto/maintenance-settings.dto';
import {
  MaintenanceSettingsService,
  type MaintenanceSettingsView,
} from './maintenance-settings.service';

export class MaintenanceSettingsResponse {
  @ApiProperty({
    type: Number,
    description: 'Hours a completed ticket waits for the reporter.',
  })
  autoCloseHours: number;
  @ApiProperty({
    type: Number,
    description: 'Days after closing during which the reporter may reopen.',
  })
  reopenDays: number;
  @ApiProperty({ type: Number, description: 'Report photos per ticket.' })
  maxReportPhotos: number;
  @ApiProperty({
    type: Number,
    description:
      'Visiting hours start, minutes after midnight in the compound’s time zone.',
  })
  visitHoursStart: number;
  @ApiProperty({
    type: Number,
    description: 'Visiting hours end, minutes after local midnight.',
  })
  visitHoursEnd: number;
  @ApiProperty({
    type: Number,
    description: 'The length of a slot residents may pick.',
  })
  visitSlotMinutes: number;

  static from(s: MaintenanceSettingsView): MaintenanceSettingsResponse {
    return {
      autoCloseHours: s.autoCloseHours,
      reopenDays: s.reopenDays,
      maxReportPhotos: s.maxReportPhotos,
      visitHoursStart: s.visitHoursStart,
      visitHoursEnd: s.visitHoursEnd,
      visitSlotMinutes: s.visitSlotMinutes,
    };
  }
}

/** The compound's maintenance settings (ADR 0032). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/settings')
export class MaintenanceSettingsController {
  constructor(private readonly settings: MaintenanceSettingsService) {}

  @Get()
  @ApiOkResponse({ type: MaintenanceSettingsResponse })
  async get(): Promise<MaintenanceSettingsResponse> {
    return MaintenanceSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @ApiOkResponse({ type: MaintenanceSettingsResponse })
  async update(
    @Body() dto: UpdateMaintenanceSettingsDto,
  ): Promise<MaintenanceSettingsResponse> {
    return MaintenanceSettingsResponse.from(await this.settings.update(dto));
  }
}
