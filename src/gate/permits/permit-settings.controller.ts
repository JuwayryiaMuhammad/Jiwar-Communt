import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { UpdatePermitSettingsDto } from './dto/permit-settings.dto';
import { PermitSettingsService } from './permit-settings.service';
import {
  PermitRulesResponse,
  PermitSettingsResponse,
} from './views/permit-settings.views';

/** The compound's permit rules, as the apps offer them (ADR 0049). */
@ApiArea('permits')
@Controller('community/permit-rules')
export class PermitRulesController {
  constructor(private readonly settings: PermitSettingsService) {}

  @Get()
  @NoStore()
  @RequireAnyPermission('permits.request', 'permits.manage', 'gate.operate')
  @ApiOperation({
    summary: 'Get the compound’s permit rules',
    description:
      'The work days, hours and days off (from today on) works and moves must fit, the time zone they are read in, and the fixed limits.',
  })
  @ApiOkResponse({ type: PermitRulesResponse })
  async get(): Promise<PermitRulesResponse> {
    return PermitRulesResponse.fromRules(await this.settings.forResidents());
  }
}

/** The compound's permit rules, as the management sets them (ADR 0049). */
@ApiArea('permits')
@RequirePermissions('permits.manage')
@Controller('staff/permit-settings')
export class PermitSettingsController {
  constructor(private readonly settings: PermitSettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the permit rules' })
  @ApiOkResponse({ type: PermitSettingsResponse })
  async get(): Promise<PermitSettingsResponse> {
    return PermitSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({
    summary: 'Change the permit rules',
    description:
      'The guard applies the new rules from the next entry; permits already approved keep their own dates and hours.',
  })
  @ApiOkResponse({ type: PermitSettingsResponse })
  async update(
    @Body() dto: UpdatePermitSettingsDto,
  ): Promise<PermitSettingsResponse> {
    return PermitSettingsResponse.from(await this.settings.update(dto));
  }
}
