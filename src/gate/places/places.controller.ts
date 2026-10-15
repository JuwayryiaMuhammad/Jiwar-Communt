import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { CreatePlaceDto, UpdatePlaceDto } from './dto/places.dto';
import { PlacesService } from './places.service';
import { ManagedPlaceView, PlaceView } from './views/place.views';

/** The compound's places, as the apps offer them (ADR 0047). */
@ApiArea('places')
@Controller('community/places')
export class CommunityPlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get()
  @NoStore()
  @RequireAnyPermission(
    'units.read',
    'gate.operate',
    'emergencies.respond',
    'gate_services.handle',
  )
  @ApiOperation({
    summary: 'List the compound’s places',
    description:
      'Those in service, in the management’s order: the `placeId`, `fromPlaceId` and `toPlaceId` of a gate service request.',
  })
  @ApiOkResponse({ type: ListOf(PlaceView) })
  async list(): Promise<ListResponse<PlaceView>> {
    return bounded(await this.places.active(), (p) => PlaceView.from(p));
  }
}

/** The places, as the management keeps them (ADR 0047). */
@ApiArea('places')
@RequirePermissions('gate.manage')
@Controller('places')
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List every place, retired ones too' })
  @ApiOkResponse({ type: ListOf(ManagedPlaceView) })
  async list(): Promise<ListResponse<ManagedPlaceView>> {
    return bounded(await this.places.all(), (p) => ManagedPlaceView.from(p));
  }

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Add a place',
    description:
      'Two places in service never share a name (409 DUPLICATE_RESOURCE).',
  })
  @ApiCreatedResponse({ type: ManagedPlaceView })
  async create(@Body() dto: CreatePlaceDto): Promise<ManagedPlaceView> {
    return ManagedPlaceView.from(await this.places.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Rename, reorder, retire or restore a place',
    description: 'A place is never deleted: requests point at it.',
  })
  @ApiOkResponse({ type: ManagedPlaceView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdatePlaceDto,
  ): Promise<ManagedPlaceView> {
    return ManagedPlaceView.from(await this.places.update(id, dto));
  }
}
