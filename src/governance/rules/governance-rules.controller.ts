import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  GovernanceRulesService,
  type GovernanceRulesView,
} from './governance-rules.service';

export class UpdateGovernanceRulesDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Refuse a candidacy while any unit the owner owns owes past its due date (an invoice under an open dispute does not count).',
  })
  @IsOptional()
  @IsBoolean()
  candidacyNoDues?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Refuse a candidacy from an owner who also holds an active staff or manager account in the compound (the same identity document).',
  })
  @IsOptional()
  @IsBoolean()
  candidacyNotStaff?: boolean;
}

export class GovernanceRulesResponse {
  @ApiProperty({ type: Boolean })
  candidacyNoDues: boolean;
  @ApiProperty({ type: Boolean })
  candidacyNotStaff: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Null until the manager first sets a rule: the defaults.',
  })
  updatedAt: Date | null;

  static from(v: GovernanceRulesView): GovernanceRulesResponse {
    return { ...v };
  }
}

/** The compound's governance rules: candidacy checks (ADR 0075). */
@ApiArea('governance')
@RequirePermissions('governance.manage')
@Controller('staff/governance/rules')
export class GovernanceRulesController {
  constructor(private readonly rules: GovernanceRulesService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The compound’s governance rules',
    description:
      'Which candidacies the system refuses at nomination (GOVERNANCE_CANDIDACY_NOT_ELIGIBLE with `params.reason`). Both off by default.',
  })
  @ApiOkResponse({ type: GovernanceRulesResponse })
  async read(): Promise<GovernanceRulesResponse> {
    return GovernanceRulesResponse.from(await this.rules.read());
  }

  @Patch()
  @NoStore()
  @ApiOperation({
    summary: 'Change the compound’s governance rules',
    description:
      'A rule applies to nominations from now on: a candidacy already standing is not withdrawn by it; the manager disqualifies with a code (ADR 0051).',
  })
  @ApiOkResponse({ type: GovernanceRulesResponse })
  async update(
    @Body() dto: UpdateGovernanceRulesDto,
  ): Promise<GovernanceRulesResponse> {
    return GovernanceRulesResponse.from(await this.rules.update(dto));
  }
}
