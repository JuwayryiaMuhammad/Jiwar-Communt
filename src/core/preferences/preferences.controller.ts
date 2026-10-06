import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { ApiArea } from '../common/http/decorators';
import { UpdatePreferencesDto } from './dto/preferences.dto';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PreferencesView } from './views/preferences.views';

/** The caller's own delivery preferences (ADR 0036); any tenant account. */
@ApiArea('preferences')
@Controller('me/notification-preferences')
export class PreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  @ApiOkResponse({ type: PreferencesView })
  async mine(): Promise<PreferencesView> {
    return PreferencesView.from(await this.preferences.mine());
  }

  @Patch()
  @ApiOkResponse({ type: PreferencesView })
  async update(@Body() dto: UpdatePreferencesDto): Promise<PreferencesView> {
    return PreferencesView.from(await this.preferences.update(dto));
  }
}
