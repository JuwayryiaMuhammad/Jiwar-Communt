import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { CreateGateDto, UpdateGateDto } from './dto/gates.dto';
import { GatesService } from './gates.service';
import { GateView } from './views/gate.views';

/** The compound's gates, for management (ADR 0028). */
@ApiArea('gates')
@Controller('gates')
export class GatesController {
  constructor(private readonly gates: GatesService) {}

  @RequirePermissions('gate.read')
  @Get()
  @ApiOkResponse({ type: ListOf(GateView) })
  async list(): Promise<ListResponse<GateView>> {
    return bounded(await this.gates.list(), (g) => GateView.from(g));
  }

  @RequirePermissions('gate.manage')
  @Post()
  @ApiCreatedResponse({ type: GateView })
  async create(@Body() dto: CreateGateDto): Promise<GateView> {
    return GateView.from(await this.gates.create(dto));
  }

  @RequirePermissions('gate.manage')
  @Patch(':id')
  @ApiOkResponse({ type: GateView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateGateDto,
  ): Promise<GateView> {
    return GateView.from(await this.gates.update(id, dto));
  }
}
