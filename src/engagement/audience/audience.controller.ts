import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { AudienceDto } from './audience';
import { AudienceCheck } from './audience-check';

export class BuildingsView {
  @ApiProperty({
    type: [String],
    description: 'The buildings the compound’s units name, in order.',
  })
  buildings: string[];
}

export class AudiencePreviewDto {
  @ApiProperty({ type: AudienceDto })
  @ValidateNested()
  @Type(() => AudienceDto)
  audience: AudienceDto;
}

export class AudienceSizeView {
  @ApiProperty({ type: Number, description: 'Units in the audience now.' })
  units: number;
  @ApiProperty({ type: Number, description: 'Accounts in the audience now.' })
  accounts: number;
}

/** What the composer needs to pick an audience (ADR 0040). */
@ApiArea('community')
@RequirePermissions('community.publish')
@Controller('community')
export class AudienceController {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly audiences: AudienceCheck,
  ) {}

  @Get('buildings')
  @NoStore()
  @ApiOperation({ summary: 'List the buildings an audience may name' })
  @ApiOkResponse({ type: BuildingsView })
  async buildings(): Promise<BuildingsView> {
    return {
      buildings: await this.tenantTx.withTenantTx((tx) =>
        this.audiences.buildings(tx),
      ),
    };
  }

  /** A read, sent as POST for its body: it changes nothing. */
  @Post('audience/preview')
  @NoStore()
  @HttpCode(200)
  @ApiOperation({ summary: 'Count who an audience is right now' })
  @ApiOkResponse({ type: AudienceSizeView })
  preview(@Body() dto: AudiencePreviewDto): Promise<AudienceSizeView> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.audiences.size(tx, await this.audiences.check(tx, dto.audience)),
    );
  }
}
