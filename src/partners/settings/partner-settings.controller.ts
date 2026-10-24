import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { UpdatePartnerSettingsDto } from './dto/partner-settings.dto';
import {
  PartnerSettingsService,
  type PartnerSettingsView,
} from './partner-settings.service';

export class PartnerSettingsResponse {
  @ApiProperty({
    type: Number,
    description:
      'A partner is shown as new this many days after it was listed.',
  })
  newDays: number;
  @ApiProperty({
    type: Number,
    description:
      '"Open late tonight" means open after this minute of the local day.',
  })
  lateFromMinute: number;
  @ApiProperty({
    type: Number,
    description: 'Requests an account may have open at once.',
  })
  maxLiveRequests: number;
  @ApiProperty({
    type: Number,
    description: 'Days after a request is done that it may be rated.',
  })
  ratingDays: number;
  @ApiProperty({
    type: Number,
    description: 'Days after a request ends that a complaint may be made.',
  })
  complaintDays: number;
  @ApiProperty({ type: Number, description: 'Days a desk link works.' })
  deskLinkDays: number;

  static from(s: PartnerSettingsView): PartnerSettingsResponse {
    return { ...s };
  }
}

/** The compound's partner settings (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff/partner-settings')
export class PartnerSettingsController {
  constructor(private readonly settings: PartnerSettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the partner settings' })
  @ApiOkResponse({ type: PartnerSettingsResponse })
  async get(): Promise<PartnerSettingsResponse> {
    return PartnerSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({ summary: 'Update the partner settings' })
  @ApiOkResponse({ type: PartnerSettingsResponse })
  async update(
    @Body() dto: UpdatePartnerSettingsDto,
  ): Promise<PartnerSettingsResponse> {
    return PartnerSettingsResponse.from(await this.settings.update(dto));
  }
}
