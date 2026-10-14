import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { UpdateFacilitySettingsDto } from './dto/facility-settings.dto';
import {
  FacilitySettingsService,
  type FacilitySettingsView,
} from './facility-settings.service';

export class FacilitySettingsResponse {
  @ApiProperty({
    type: Number,
    description: 'No-shows within the window that suspend a unit.',
  })
  noShowThreshold: number;
  @ApiProperty({
    type: Number,
    description: 'Days the no-shows are counted over.',
  })
  noShowWindowDays: number;
  @ApiProperty({ type: Number, description: 'Days a suspension lasts.' })
  suspensionDays: number;

  static from(s: FacilitySettingsView): FacilitySettingsResponse {
    return { ...s };
  }
}

/** The compound's facility settings (ADR 0044). */
@ApiArea('facilities')
@RequirePermissions('facilities.manage')
@Controller('staff/facility-settings')
export class FacilitySettingsController {
  constructor(private readonly settings: FacilitySettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the facility settings' })
  @ApiOkResponse({ type: FacilitySettingsResponse })
  async get(): Promise<FacilitySettingsResponse> {
    return FacilitySettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({ summary: 'Update the facility settings' })
  @ApiOkResponse({ type: FacilitySettingsResponse })
  async update(
    @Body() dto: UpdateFacilitySettingsDto,
  ): Promise<FacilitySettingsResponse> {
    return FacilitySettingsResponse.from(await this.settings.update(dto));
  }
}
