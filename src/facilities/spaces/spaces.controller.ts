import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
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
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  CreateFloorPlanDto,
  CreateSpaceUseDto,
  FloorPlansQueryDto,
  ImageDto,
  SetHotspotsDto,
  SetMapPointsDto,
  SpaceUseReasonDto,
  SpaceUsesQueryDto,
  StaffSpaceUsesQueryDto,
} from './dto/spaces.dto';
import { FloorPlansService } from './floor-plans.service';
import { SiteMapService } from './site-map.service';
import { SpaceUsesService } from './space-uses.service';
import {
  FloorPlanSummaryView,
  FloorPlanView,
  ResidentSpaceUseView,
  SiteMapView,
  SpaceUseAreaView,
  SpaceUseView,
  UnitFloorPlanView,
} from './views/spaces.views';

/** The compound's site map, as the management keeps it (ADR 0084). */
@ApiArea('spaces')
@Controller('staff/site-map')
export class StaffSiteMapController {
  constructor(private readonly map: SiteMapService) {}

  @Get()
  @NoStore()
  @RequireAnyPermission(
    'spaces.manage',
    'facilities.manage',
    'assets.read',
    'gate.read',
  )
  @ApiOperation({ summary: 'Get the site map and its points' })
  @ApiOkResponse({ type: SiteMapView })
  async get(): Promise<SiteMapView> {
    return SiteMapView.from(await this.map.read('staff'));
  }

  @Put('image')
  @NoStore()
  @RequirePermissions('spaces.manage')
  @ApiOperation({
    summary: 'Set or replace the site map’s image',
    description:
      'An upload of the purpose `site_map`. The points stay where they were, as fractions of the image.',
  })
  @ApiOkResponse({ type: SiteMapView })
  async setImage(@Body() dto: ImageDto): Promise<SiteMapView> {
    return SiteMapView.from(await this.map.setImage(dto.fileId));
  }

  @Put('points')
  @NoStore()
  @RequirePermissions('spaces.manage')
  @ApiOperation({
    summary: 'Replace the site map’s points',
    description: 'The image first (SITE_MAP_NOT_SET).',
  })
  @ApiOkResponse({ type: SiteMapView })
  async setPoints(@Body() dto: SetMapPointsDto): Promise<SiteMapView> {
    return SiteMapView.from(await this.map.setPoints(dto.points));
  }
}

/** The compound's site map, as the apps show it (ADR 0084). */
@ApiArea('spaces')
@RequirePermissions('facilities.book')
@Controller('site-map')
export class SiteMapController {
  constructor(private readonly map: SiteMapService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Get the site map',
    description: 'Its buildings, active gates and active facilities.',
  })
  @ApiOkResponse({ type: SiteMapView })
  async get(): Promise<SiteMapView> {
    return SiteMapView.from(await this.map.read('residents'));
  }
}

/** The buildings' floor plans and their units' boxes (ADR 0084). */
@ApiArea('spaces')
@Controller('staff/floor-plans')
export class StaffFloorPlansController {
  constructor(private readonly plans: FloorPlansService) {}

  @Get()
  @RequireAnyPermission('spaces.manage', 'units.directory', 'assets.read')
  @ApiOperation({ summary: 'List the floor plans, by building and floor' })
  @ApiOkResponse({ type: ListOf(FloorPlanSummaryView) })
  async list(
    @Query() q: FloorPlansQueryDto,
  ): Promise<ListResponse<FloorPlanSummaryView>> {
    return bounded(await this.plans.list(q.buildingId), (p) =>
      FloorPlanSummaryView.from(p),
    );
  }

  @Post()
  @NoStore()
  @RequirePermissions('spaces.manage')
  @ApiOperation({
    summary: 'Add a building floor’s plan',
    description: 'An upload of the purpose `floor_plan`; one plan a floor.',
  })
  @ApiCreatedResponse({ type: FloorPlanView })
  async create(@Body() dto: CreateFloorPlanDto): Promise<FloorPlanView> {
    return FloorPlanView.fromRead(await this.plans.create(dto));
  }

  @Get(':id')
  @NoStore()
  @RequireAnyPermission('spaces.manage', 'units.directory', 'assets.read')
  @ApiOperation({ summary: 'Get a floor plan with its units’ boxes' })
  @ApiOkResponse({ type: FloorPlanView })
  async get(@Param('id', parseId()) id: string): Promise<FloorPlanView> {
    return FloorPlanView.fromRead(await this.plans.get(id));
  }

  @Put(':id/image')
  @NoStore()
  @RequirePermissions('spaces.manage')
  @ApiOperation({ summary: 'Replace a floor plan’s image' })
  @ApiOkResponse({ type: FloorPlanView })
  async setImage(
    @Param('id', parseId()) id: string,
    @Body() dto: ImageDto,
  ): Promise<FloorPlanView> {
    return FloorPlanView.fromRead(await this.plans.setImage(id, dto.fileId));
  }

  @Put(':id/hotspots')
  @NoStore()
  @RequirePermissions('spaces.manage')
  @ApiOperation({
    summary: 'Replace a floor plan’s unit boxes',
    description:
      'Units of its building and floor, each a box inside the image. A box a unit kept on another floor’s plan goes.',
  })
  @ApiOkResponse({ type: FloorPlanView })
  async setHotspots(
    @Param('id', parseId()) id: string,
    @Body() dto: SetHotspotsDto,
  ): Promise<FloorPlanView> {
    return FloorPlanView.fromRead(
      await this.plans.setHotspots(id, dto.hotspots),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('spaces.manage')
  @ApiOperation({ summary: 'Remove a floor plan, its image and its boxes' })
  @ApiNoContentResponse()
  async remove(@Param('id', parseId()) id: string): Promise<void> {
    await this.plans.remove(id);
  }
}

/** A unit's floor plan, as its household sees it (ADR 0084). */
@ApiArea('spaces')
@RequirePermissions('units.read')
@Controller('units/:unitId/floor-plan')
export class UnitFloorPlanController {
  constructor(private readonly plans: FloorPlansService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Get the plan of the unit’s floor, with the unit marked',
    description:
      'The unit’s own box only: no other unit or anyone in it (FLOOR_PLAN_NOT_FOUND when its floor has none).',
  })
  @ApiOkResponse({ type: UnitFloorPlanView })
  async get(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<UnitFloorPlanView> {
    return UnitFloorPlanView.from(await this.plans.forUnit(unitId));
  }
}

/** The common areas open to use requests, as the management keeps them. */
@ApiArea('spaces')
@Controller('staff/space-use-areas')
export class StaffSpaceUseAreasController {
  constructor(private readonly uses: SpaceUsesService) {}

  @Get()
  @RequireAnyPermission('spaces.manage', 'bookings.handle')
  @ApiOperation({ summary: 'List the common areas open to use requests' })
  @ApiOkResponse({ type: ListOf(SpaceUseAreaView) })
  async list(): Promise<ListResponse<SpaceUseAreaView>> {
    return bounded(await this.uses.areas('staff'), (a) =>
      SpaceUseAreaView.from(a),
    );
  }

  @Put(':commonAreaId')
  @HttpCode(204)
  @RequirePermissions('spaces.manage')
  @ApiOperation({
    summary: 'Open a common area to use requests',
    description: 'An active area or facility, not a building as a whole.',
  })
  @ApiNoContentResponse()
  async open(
    @Param('commonAreaId', parseId('commonAreaId')) id: string,
  ): Promise<void> {
    await this.uses.openArea(id);
  }

  @Delete(':commonAreaId')
  @HttpCode(204)
  @RequirePermissions('spaces.manage')
  @ApiOperation({
    summary: 'Take no more use requests for a common area',
    description: 'What was asked or approved stands.',
  })
  @ApiNoContentResponse()
  async close(
    @Param('commonAreaId', parseId('commonAreaId')) id: string,
  ): Promise<void> {
    await this.uses.closeArea(id);
  }
}

/** The common areas residents may ask to use (ADR 0084). */
@ApiArea('spaces')
@RequirePermissions('facilities.book')
@Controller('space-use-areas')
export class SpaceUseAreasController {
  constructor(private readonly uses: SpaceUsesService) {}

  @Get()
  @ApiOperation({ summary: 'List the common areas one may ask to use' })
  @ApiOkResponse({ type: ListOf(SpaceUseAreaView) })
  async list(): Promise<ListResponse<SpaceUseAreaView>> {
    return bounded(await this.uses.areas('residents'), (a) =>
      SpaceUseAreaView.from(a),
    );
  }
}

/** A unit's common-area use requests (ADR 0084). */
@ApiArea('spaces')
@RequirePermissions('facilities.book')
@Controller('units/:unitId/space-uses')
export class UnitSpaceUsesController {
  constructor(
    private readonly uses: SpaceUsesService,
    private readonly ctx: RequestContext,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Ask to use a common area for a time',
    description:
      'For whoever books for the unit (BOOKINGS_NOT_ALLOWED); three live per unit (SPACE_USE_LIMIT). The staff decide; an approved use of a facility’s area closes it to bookings then.',
  })
  @ApiCreatedResponse({ type: ResidentSpaceUseView })
  async create(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateSpaceUseDto,
  ): Promise<ResidentSpaceUseView> {
    return ResidentSpaceUseView.of(
      await this.uses.request(unitId, dto),
      this.ctx.accountId,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List the unit’s use requests the caller sees, newest first',
    description:
      'The caller’s own; the unit’s primary sees all of them, except during a separation.',
  })
  @ApiOkResponse({ type: ListOf(ResidentSpaceUseView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: SpaceUsesQueryDto,
  ): Promise<ListResponse<ResidentSpaceUseView>> {
    return toList(await this.uses.forUnit(unitId, q), (r) =>
      ResidentSpaceUseView.of(r, this.ctx.accountId),
    );
  }
}

/** One use request the caller sees (ADR 0084). */
@ApiArea('spaces')
@RequirePermissions('facilities.book')
@Controller('space-uses')
export class SpaceUsesController {
  constructor(private readonly uses: SpaceUsesService) {}

  @Post(':id/withdraw')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Withdraw a use request before it starts',
    description:
      'Its requester or the unit’s primary; pending or approved (SPACE_USE_DECIDED), not started (SPACE_USE_STARTED).',
  })
  @ApiNoContentResponse()
  async withdraw(
    @Param('id', parseId()) id: string,
    @Body() dto: SpaceUseReasonDto,
  ): Promise<void> {
    await this.uses.withdraw(id, dto.reasonCode);
  }
}

/** The use requests, as the staff decide them (ADR 0084). */
@ApiArea('spaces')
@RequirePermissions('bookings.handle')
@Controller('staff/space-uses')
export class StaffSpaceUsesController {
  constructor(private readonly uses: SpaceUsesService) {}

  @Get()
  @ApiOperation({ summary: 'List use requests, newest first' })
  @ApiOkResponse({ type: ListOf(SpaceUseView) })
  async list(
    @Query() q: StaffSpaceUsesQueryDto,
  ): Promise<ListResponse<SpaceUseView>> {
    return toList(await this.uses.list(q), (r) => SpaceUseView.from(r));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a use request' })
  @ApiOkResponse({ type: SpaceUseView })
  async get(@Param('id', parseId()) id: string): Promise<SpaceUseView> {
    return SpaceUseView.from(await this.uses.get(id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a use request',
    description:
      'Pending and not started; no approved use of the area overlaps it (SPACE_USE_OVERLAP); on a facility’s area, no booking holds it then (SPACE_USE_BOOKED) and no closure (FACILITY_CLOSED). The requester is told.',
  })
  @ApiOkResponse({ type: SpaceUseView })
  async approve(@Param('id', parseId()) id: string): Promise<SpaceUseView> {
    return SpaceUseView.from(await this.uses.approve(id));
  }

  @Post(':id/refuse')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refuse a use request, with a reason code' })
  @ApiOkResponse({ type: SpaceUseView })
  async refuse(
    @Param('id', parseId()) id: string,
    @Body() dto: SpaceUseReasonDto,
  ): Promise<SpaceUseView> {
    return SpaceUseView.from(await this.uses.refuse(id, dto.reasonCode));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel an approved use before it ends, with a reason code',
  })
  @ApiOkResponse({ type: SpaceUseView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: SpaceUseReasonDto,
  ): Promise<SpaceUseView> {
    return SpaceUseView.from(await this.uses.cancel(id, dto.reasonCode));
  }
}
