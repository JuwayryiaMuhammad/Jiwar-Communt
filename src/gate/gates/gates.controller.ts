import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { CreateGateDto, UpdateGateDto } from './dto/gates.dto';
import { GatesService } from './gates.service';
import { GateStatusView, GateView } from './views/gate.views';

/** The compound's gates: for management, and their status for residents (ADR 0028). */
@ApiArea('gates')
@Controller('gates')
export class GatesController {
  constructor(private readonly gates: GatesService) {}

  @RequirePermissions('gate.read')
  @Get()
  @ApiOperation({ summary: "List the compound's gates" })
  @ApiOkResponse({ type: ListOf(GateView) })
  async list(): Promise<ListResponse<GateView>> {
    return bounded(await this.gates.list(), (g) => GateView.from(g));
  }

  /**
   * No permission: the account kind decides (resident or family), in the
   * service. Declared before `:id`.
   */
  @Get('status')
  @ApiOperation({ summary: 'See which gates are open (residents and family)' })
  @NoStore()
  @ApiOkResponse({ type: ListOf(GateStatusView) })
  async status(): Promise<ListResponse<GateStatusView>> {
    return bounded(await this.gates.statuses(), (g) => GateStatusView.from(g));
  }

  @RequirePermissions('gate.manage')
  @Post()
  @ApiOperation({ summary: 'Create a gate' })
  @ApiCreatedResponse({ type: GateView })
  async create(@Body() dto: CreateGateDto): Promise<GateView> {
    return GateView.from(await this.gates.create(dto));
  }

  @RequirePermissions('gate.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Update a gate' })
  @ApiOkResponse({ type: GateView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateGateDto,
  ): Promise<GateView> {
    return GateView.from(await this.gates.update(id, dto));
  }
}
