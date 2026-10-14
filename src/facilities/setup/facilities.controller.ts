import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
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
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CreateFacilityDto,
  ReplaceFacilityWindowsDto,
  UpdateFacilityDto,
} from './dto/facilities.dto';
import { FacilitiesService } from './facilities.service';
import { FacilityView, StaffFacilityView } from './views/facility.views';

/** The compound's facilities, as residents see them (ADR 0044). */
@ApiArea('facilities')
@RequirePermissions('facilities.book')
@Controller('facilities')
export class FacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the facilities' })
  @ApiOkResponse({ type: ListOf(FacilityView) })
  async list(): Promise<ListResponse<FacilityView>> {
    return bounded(await this.facilities.residentList(), (f) =>
      FacilityView.from(f),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a facility' })
  @ApiOkResponse({ type: FacilityView })
  async get(@Param('id', parseId()) id: string): Promise<FacilityView> {
    return FacilityView.from(await this.facilities.residentGet(id));
  }
}

/** The compound's facilities, for the staff who set them up or work them. */
@ApiArea('facilities')
@Controller('staff/facilities')
export class StaffFacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @Get()
  @NoStore()
  @RequireAnyPermission('facilities.manage', 'bookings.handle')
  @ApiOperation({ summary: 'List every facility, retired ones included' })
  @ApiOkResponse({ type: ListOf(StaffFacilityView) })
  async list(): Promise<ListResponse<StaffFacilityView>> {
    return bounded(await this.facilities.staffList(), (f) =>
      StaffFacilityView.from(f),
    );
  }

  @Get(':id')
  @NoStore()
  @RequireAnyPermission('facilities.manage', 'bookings.handle')
  @ApiOperation({ summary: 'Get a facility with its rules' })
  @ApiOkResponse({ type: StaffFacilityView })
  async get(@Param('id', parseId()) id: string): Promise<StaffFacilityView> {
    return StaffFacilityView.from(await this.facilities.staffGet(id));
  }

  @Post()
  @NoStore()
  @RequirePermissions('facilities.manage')
  @ApiOperation({ summary: 'Create a facility' })
  @Idempotent()
  @ApiCreatedResponse({ type: StaffFacilityView })
  async create(@Body() dto: CreateFacilityDto): Promise<StaffFacilityView> {
    return StaffFacilityView.from(await this.facilities.create(dto));
  }

  @Patch(':id')
  @NoStore()
  @RequirePermissions('facilities.manage')
  @ApiOperation({ summary: 'Update a facility: names, order, state, rules' })
  @ApiOkResponse({ type: StaffFacilityView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateFacilityDto,
  ): Promise<StaffFacilityView> {
    return StaffFacilityView.from(await this.facilities.update(id, dto));
  }

  @Put(':id/hours')
  @NoStore()
  @RequirePermissions('facilities.manage')
  @ApiOperation({ summary: 'Replace a facility’s opening hours' })
  @ApiOkResponse({ type: StaffFacilityView })
  async replaceHours(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplaceFacilityWindowsDto,
  ): Promise<StaffFacilityView> {
    return StaffFacilityView.from(
      await this.facilities.replaceHours(id, dto.windows),
    );
  }

  @Put(':id/peak-windows')
  @NoStore()
  @RequirePermissions('facilities.manage')
  @ApiOperation({ summary: 'Replace a bookable facility’s peak times' })
  @ApiOkResponse({ type: StaffFacilityView })
  async replacePeaks(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplaceFacilityWindowsDto,
  ): Promise<StaffFacilityView> {
    return StaffFacilityView.from(
      await this.facilities.replacePeaks(id, dto.windows),
    );
  }
}
