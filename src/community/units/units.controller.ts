import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
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

  /**
   * The units the caller may see, newest first; every unit for a staff role
   * holding `units.directory` (the security supervisor's).
   */
  @RequireAnyPermission('units.read', 'units.directory')
  @Get()
  @ApiOperation({
    summary: 'List the units I may see',
    description:
      'Newest first. Every unit for the manager and for a staff role holding `units.directory` (the security supervisor); a resident or a family member lists their own.',
  })
  @ApiOkResponse({ type: ListOf(UnitView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<UnitView>> {
    return toList(await this.units.list(q), (u) => UnitView.from(u));
  }

  @RequirePermissions('units.create')
  @Post()
  @ApiOperation({ summary: 'Create a unit' })
  @ApiCreatedResponse({ type: UnitView })
  async create(@Body() dto: CreateUnitDto): Promise<UnitView> {
    return UnitView.from(await this.units.create(dto));
  }
}
