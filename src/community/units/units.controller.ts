import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { UnitDetailView } from '../residents/views/occupancy.views';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
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

  /** ADR 0072: never the code (QR codes, permits and certificates print it). */
  @RequirePermissions('units.manage')
  @Patch(':id')
  @ApiOperation({
    summary: 'Change a unit’s building, floor, type or area',
  })
  @ApiOkResponse({ type: UnitDetailView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateUnitDto,
  ): Promise<UnitDetailView> {
    const u = await this.units.update(id, dto);
    return UnitDetailView.from({
      id: u.id,
      code: u.code,
      building: u.building,
      buildingId: u.buildingId,
      floor: u.floor,
      unitType: u.unitType,
      areaSqm: u.areaSqm?.toFixed(2) ?? null,
      closed: u.closedSince !== null,
      createdAt: u.createdAt,
    });
  }
}
