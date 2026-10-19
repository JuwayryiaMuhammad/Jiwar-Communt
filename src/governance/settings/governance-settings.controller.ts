import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { SETTING_TYPES, type SettingType } from '../approvals/approval-rules';
import { UpdateGovernanceSettingsDto } from './dto/governance-settings.dto';
import {
  GovernanceSettingsService,
  type GovernanceSettingView,
} from './governance-settings.service';

export class GovernanceSettingResponse {
  @ApiProperty({ enum: SETTING_TYPES, enumName: 'GovernanceSettingType' })
  type: SettingType;
  @ApiProperty({
    type: Number,
    description: 'Days the board has to decide a matter of this type.',
  })
  deadlineDays: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP, or none set.',
  })
  threshold: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Whether the type takes a threshold.',
  })
  thresholded: boolean;
}

export class GovernanceSettingsResponse {
  @ApiProperty({ type: [GovernanceSettingResponse] })
  items: GovernanceSettingResponse[];

  static from(items: GovernanceSettingView[]): GovernanceSettingsResponse {
    return { items: items.map((i) => ({ ...i })) };
  }
}

/** The board's deadlines and thresholds (ADR 0055). */
@ApiArea('governance')
@Controller('staff/governance/settings')
export class GovernanceSettingsController {
  constructor(private readonly settings: GovernanceSettingsService) {}

  @Get()
  @RequireAnyPermission('governance.manage', 'governance.approvals')
  @NoStore()
  @ApiOperation({
    summary: 'Get the board’s deadlines and thresholds',
    description:
      'One row per approval type and one for appeals to the board (`board_appeal`); read by who raises requests too.',
  })
  @ApiOkResponse({ type: GovernanceSettingsResponse })
  async get(): Promise<GovernanceSettingsResponse> {
    return GovernanceSettingsResponse.from(await this.settings.get());
  }

  @Patch()
  @RequirePermissions('governance.manage')
  @NoStore()
  @ApiOperation({
    summary: 'Change the board’s deadlines and thresholds',
    description:
      'A deadline applies to matters raised from now on. A threshold is shown when a request is raised; `major_contract`’s is the manager’s limit for one expense.',
  })
  @ApiOkResponse({ type: GovernanceSettingsResponse })
  async update(
    @Body() dto: UpdateGovernanceSettingsDto,
  ): Promise<GovernanceSettingsResponse> {
    return GovernanceSettingsResponse.from(
      await this.settings.update(dto.items),
    );
  }
}
