import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { UnitDetailView } from '../residents/views/occupancy.views';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UnitFiltersDto, UnitsQueryDto } from './dto/units-query.dto';
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
      'Newest first. Every unit for the manager and for a staff role holding `units.directory` (the security supervisor); a resident or a family member lists their own. `q` and `buildingId` narrow it for anyone; `status` and `occupancyType` are the manager’s (`units.manage`), FIELD_NOT_ALLOWED otherwise.',
  })
  @ApiOkResponse({ type: ListOf(UnitView) })
  async list(@Query() q: UnitsQueryDto): Promise<ListResponse<UnitView>> {
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

/** The unit register's staff reads (ADR 0072). */
@ApiArea('units')
@RequirePermissions('units.manage')
@Controller('staff/units')
export class StaffUnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get('export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'The units, with the same filters, as CSV',
    description:
      'One row per unit by code: building, floor, type, area, status, and how many hold a place as owners, as tenants and living there. Counts, never names. At most 100 000 rows (EXPORT_TOO_LARGE).',
  })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: UnitFiltersDto): Promise<StreamableFile> {
    return csvFile('units.csv', await this.units.csv(q));
  }
}
