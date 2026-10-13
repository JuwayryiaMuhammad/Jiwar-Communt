import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { UpdateNeighbourSettingsDto } from './dto/neighbour-settings.dto';
import {
  NeighbourSettingsService,
  type NeighbourSettingsView,
} from './neighbour-settings.service';

export class NeighbourSettingsResponse {
  @ApiProperty({
    type: Number,
    description: 'Complaints one author may have open at once.',
  })
  maxOpenComplaints: number;

  @ApiProperty({
    type: Number,
    description: 'Days a lost or found post stays on the board.',
  })
  lostFoundExpiryDays: number;

  @ApiProperty({
    type: Number,
    description: 'Days a lending post stays on the board.',
  })
  lendingExpiryDays: number;

  @ApiProperty({
    type: Number,
    description: 'Posts one author may have on the boards at once.',
  })
  maxOpenPosts: number;

  @ApiProperty({
    type: Number,
    description: 'Conversations one account may start in 24 hours.',
  })
  maxNewConversationsPerDay: number;

  static from(s: NeighbourSettingsView): NeighbourSettingsResponse {
    return { ...s };
  }
}

/** The compound's neighbours settings (ADR 0042). */
@ApiArea('neighbours')
@RequirePermissions('neighbours.manage')
@Controller('neighbours/settings')
export class NeighbourSettingsController {
  constructor(private readonly settings: NeighbourSettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the neighbours settings' })
  @ApiOkResponse({ type: NeighbourSettingsResponse })
  async get(): Promise<NeighbourSettingsResponse> {
    return NeighbourSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({ summary: 'Update the neighbours settings' })
  @ApiOkResponse({ type: NeighbourSettingsResponse })
  async update(
    @Body() dto: UpdateNeighbourSettingsDto,
  ): Promise<NeighbourSettingsResponse> {
    return NeighbourSettingsResponse.from(await this.settings.update(dto));
  }
}
