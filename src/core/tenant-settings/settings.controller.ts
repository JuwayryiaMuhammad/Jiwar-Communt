import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea } from '../common/http/decorators';
import { UpdateSettingsDto } from './dto/settings.dto';
import {
  TenantSettingsService,
  type TenantSettingsView,
} from './tenant-settings.service';

export class SettingsView {
  @ApiProperty({ type: Boolean })
  familyJoinRequiresApproval: boolean;
  @ApiProperty({ type: Number })
  maxHouseholdMembers: number;
  @ApiProperty({
    type: String,
    description: 'IANA; worker schedules are read in it.',
  })
  timezone: string;
  @ApiProperty({ type: Number, description: 'Active visitor passes per unit.' })
  maxActiveVisitorPasses: number;
  @ApiProperty({
    type: Number,
    description:
      'Seconds a household has to answer the gate before its instruction applies.',
  })
  gateRequestTimeoutSeconds: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Shown to visitors on the public pass page (ADR 0030).',
  })
  visitorDirections: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'E.164; on the visitor page and the worker card.',
  })
  emergencyPhone: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'E.164; the community office, in a unit’s emergency contacts.',
  })
  officePhone: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'E.164; the duty manager, in a unit’s emergency contacts and for a responder who is not at a gate.',
  })
  dutyPhone: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'Whether households may write `always_allow` standing instructions (ADR 0043). Off: none is created (ALWAYS_ALLOW_DISABLED) and the guard sees those that exist as `call_first`.',
  })
  allowAlwaysAllow: boolean;

  static from(s: TenantSettingsView): SettingsView {
    return {
      familyJoinRequiresApproval: s.familyJoinRequiresApproval,
      maxHouseholdMembers: s.maxHouseholdMembers,
      timezone: s.timezone,
      maxActiveVisitorPasses: s.maxActiveVisitorPasses,
      gateRequestTimeoutSeconds: s.gateRequestTimeoutSeconds,
      visitorDirections: s.visitorDirections,
      emergencyPhone: s.emergencyPhone,
      officePhone: s.officePhone,
      dutyPhone: s.dutyPhone,
      allowAlwaysAllow: s.allowAlwaysAllow,
    };
  }
}

/** The compound's own settings (ADR 0016). */
@ApiArea('admin')
@RequirePermissions('settings.manage')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Get()
  @ApiOperation({ summary: "Get the compound's settings" })
  @ApiOkResponse({ type: SettingsView })
  async get(): Promise<SettingsView> {
    return SettingsView.from(await this.settings.get());
  }

  @Patch()
  @ApiOperation({ summary: "Update the compound's settings" })
  @ApiOkResponse({ type: SettingsView })
  async update(@Body() dto: UpdateSettingsDto): Promise<SettingsView> {
    return SettingsView.from(await this.settings.update(dto));
  }
}
