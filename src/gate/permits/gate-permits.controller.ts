import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { GatePermitsService } from './gate-permits.service';
import { GatePermitView } from './views/gate-permit.views';

export class GatePermitsQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    example: 'B-12',
    description: 'A unit’s code: its permits in force today.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  unitCode?: string;

  @ApiProperty({
    type: String,
    required: false,
    example: 'W-0042',
    description:
      'A permit’s reference, as the household shows it (`W-42` and `w42` too). Exactly one of the two.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 16, withParams({ min: 1, max: 16 }))
  reference?: string;
}

/** The units' permits at the gate (ADR 0049), inside a shift. */
@ApiArea('permits')
@RequirePermissions('gate.operate')
@Controller('gate/unit-permits')
export class GatePermitsController {
  constructor(private readonly permits: GatePermitsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Find the permits in force today',
    description:
      'By a unit’s code or a permit’s reference: approved permits whose window touches today. No faces here: open one. Rate-limited and audited on the shift.',
  })
  @ApiOkResponse({ type: ListOf(GatePermitView) })
  async find(
    @Query() q: GatePermitsQueryDto,
  ): Promise<ListResponse<GatePermitView>> {
    return bounded(await this.permits.find(q), (r) => GatePermitView.from(r));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a permit at the gate',
    description:
      'In force today, or with someone of it inside. The workers’ faces (never the last four of their ID), the truck, the goods, and the guest list while the event is on. Then record entries with `POST /gate/entries`.',
  })
  @ApiOkResponse({ type: GatePermitView })
  async get(@Param('id', parseId()) id: string): Promise<GatePermitView> {
    return GatePermitView.from(await this.permits.get(id));
  }
}
