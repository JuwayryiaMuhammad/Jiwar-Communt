import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';
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

  static from(s: TenantSettingsView): SettingsView {
    return {
      familyJoinRequiresApproval: s.familyJoinRequiresApproval,
      maxHouseholdMembers: s.maxHouseholdMembers,
      timezone: s.timezone,
      maxActiveVisitorPasses: s.maxActiveVisitorPasses,
      gateRequestTimeoutSeconds: s.gateRequestTimeoutSeconds,
      visitorDirections: s.visitorDirections,
      emergencyPhone: s.emergencyPhone,
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
  @ApiOkResponse({ type: SettingsView })
  async get(): Promise<SettingsView> {
    return SettingsView.from(await this.settings.get());
  }

  @Patch()
  @ApiOkResponse({ type: SettingsView })
  async update(@Body() dto: UpdateSettingsDto): Promise<SettingsView> {
    return SettingsView.from(await this.settings.update(dto));
  }
}
