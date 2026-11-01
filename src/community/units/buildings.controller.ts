import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { BuildingsService } from './buildings.service';
import { CreateBuildingDto } from './dto/buildings.dto';
import { BuildingView } from './views/building.view';

/** The compound's buildings (ADR 0072). */
@ApiArea('units')
@Controller('buildings')
export class BuildingsController {
  constructor(private readonly buildings: BuildingsService) {}

  /** For the unit register, and the staff who list units by building. */
  @RequireAnyPermission('units.manage', 'units.directory')
  @Get()
  @ApiOperation({ summary: 'List the buildings, by name, with their units' })
  @ApiOkResponse({ type: ListOf(BuildingView) })
  async list(): Promise<ListResponse<BuildingView>> {
    return bounded(await this.buildings.list(), (b) => BuildingView.from(b));
  }

  @RequirePermissions('units.manage')
  @Post()
  @ApiOperation({ summary: 'Add a building ahead of its units' })
  @ApiCreatedResponse({ type: BuildingView })
  async create(@Body() dto: CreateBuildingDto): Promise<BuildingView> {
    return BuildingView.from(await this.buildings.create(dto.name));
  }

  @RequirePermissions('units.manage')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a building no unit names' })
  @ApiNoContentResponse()
  async remove(@Param('id', parseId()) id: string): Promise<void> {
    await this.buildings.remove(id);
  }
}
