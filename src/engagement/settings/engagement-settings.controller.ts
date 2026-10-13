import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { UpdateEngagementSettingsDto } from './dto/engagement-settings.dto';
import {
  EngagementSettingsService,
  type EngagementSettingsView,
} from './engagement-settings.service';

export class EngagementSettingsResponse {
  @ApiProperty({
    type: Number,
    description: 'Guests one "going" answer to an event may bring, at most.',
  })
  eventMaxGuests: number;

  static from(s: EngagementSettingsView): EngagementSettingsResponse {
    return { eventMaxGuests: s.eventMaxGuests };
  }
}

/** The compound's community settings (ADR 0040). */
@ApiArea('community')
@RequirePermissions('community.publish')
@Controller('community/settings')
export class EngagementSettingsController {
  constructor(private readonly settings: EngagementSettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the community settings' })
  @ApiOkResponse({ type: EngagementSettingsResponse })
  async get(): Promise<EngagementSettingsResponse> {
    return EngagementSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({ summary: 'Update the community settings' })
  @ApiOkResponse({ type: EngagementSettingsResponse })
  async update(
    @Body() dto: UpdateEngagementSettingsDto,
  ): Promise<EngagementSettingsResponse> {
    return EngagementSettingsResponse.from(await this.settings.update(dto));
  }
}
