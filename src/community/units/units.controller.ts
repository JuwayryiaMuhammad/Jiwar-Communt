import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UnitsService } from './units.service';
import { UnitView } from './views/unit.view';

/** Units (ADR 0012); one unit's detail and actions are in the residents domain. */
@ApiArea('units')
@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  /** The units the caller may see, newest first. */
  @RequirePermissions('units.read')
  @Get()
  @ApiOkResponse({ type: ListOf(UnitView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<UnitView>> {
    return toList(await this.units.list(q), (u) => UnitView.from(u));
  }

  @RequirePermissions('units.create')
  @Post()
  @ApiCreatedResponse({ type: UnitView })
  async create(@Body() dto: CreateUnitDto): Promise<UnitView> {
    return UnitView.from(await this.units.create(dto));
  }
}
