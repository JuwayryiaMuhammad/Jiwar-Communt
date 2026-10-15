import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CreateParkingSlotDto,
  CreateVisitorAreaDto,
  CreateVisitorParkingDto,
  ParkingSlotsQueryDto,
  StaffCancelVisitorParkingDto,
  StaffVisitorParkingQueryDto,
  UpdateParkingSlotDto,
  UpdateVisitorAreaDto,
  VisitorParkingQueryDto,
} from './dto/parking.dto';
import { StaffParkingService } from './staff-parking.service';
import { VisitorParkingService } from './visitor-parking.service';
import {
  StaffParkingSlotView,
  StaffVisitorParkingBookingView,
  UnitParkingView,
  VisitorParkingAreaView,
  VisitorParkingBookingView,
} from './views/parking.views';

/** A unit's parking and its visitors' bookings (ADR 0045). */
@ApiArea('parking')
@Controller('units/:unitId')
export class UnitParkingController {
  constructor(private readonly visitors: VisitorParkingService) {}

  @Get('parking')
  @NoStore()
  @RequirePermissions('units.read')
  @ApiOperation({
    summary: 'Get the unit’s parking slots and the visitor areas’ free spaces',
    description: 'For any member of the unit. Free spaces are now’s.',
  })
  @ApiOkResponse({ type: UnitParkingView })
  async parking(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<UnitParkingView> {
    return UnitParkingView.from(await this.visitors.unitParking(unitId));
  }

  @Get('visitor-parking-bookings')
  @NoStore()
  @RequirePermissions('visitors.invite')
  @ApiOperation({
    summary: 'List the unit’s visitor parking bookings',
    description: 'The primary sees every one; anyone else who may invite, their own.',
  })
  @ApiOkResponse({ type: ListOf(VisitorParkingBookingView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: VisitorParkingQueryDto,
  ): Promise<ListResponse<VisitorParkingBookingView>> {
    return toList(await this.visitors.list(unitId, q), (b) =>
      VisitorParkingBookingView.from(b),
    );
  }

  @Post('visitor-parking-bookings')
  @NoStore()
  @Idempotent()
  @RequirePermissions('visitors.invite')
  @ApiOperation({
    summary: 'Book a visitor parking space',
    description:
      'For a visitor pass of the unit or a visitor’s name. Never past the area’s capacity at any instant of the window (VISITOR_PARKING_FULL); at most the compound’s `maxActiveVisitorParkingBookings` not yet ended (VISITOR_PARKING_LIMIT_REACHED).',
  })
  @ApiCreatedResponse({ type: VisitorParkingBookingView })
  async book(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateVisitorParkingDto,
  ): Promise<VisitorParkingBookingView> {
    return VisitorParkingBookingView.from(
      await this.visitors.book(unitId, dto),
    );
  }

  @Delete('visitor-parking-bookings/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('visitors.invite')
  @ApiOperation({
    summary: 'Cancel a visitor parking booking',
    description: 'Its booker or the unit’s primary, until it ends.',
  })
  @ApiNoContentResponse()
  async cancel(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<void> {
    await this.visitors.cancel(unitId, id);
  }
}

/** The units' own parking slots, for the staff (ADR 0045). */
@ApiArea('parking')
@RequirePermissions('vehicles.manage')
@Controller('staff/parking-slots')
export class ParkingSlotsController {
  constructor(private readonly parking: StaffParkingService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the units’ parking slots' })
  @ApiOkResponse({ type: ListOf(StaffParkingSlotView) })
  async list(
    @Query() q: ParkingSlotsQueryDto,
  ): Promise<ListResponse<StaffParkingSlotView>> {
    return toList(await this.parking.listSlots(q), (s) =>
      StaffParkingSlotView.from(s),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Give a unit a parking slot' })
  @ApiCreatedResponse({ type: StaffParkingSlotView })
  async create(@Body() dto: CreateParkingSlotDto): Promise<StaffParkingSlotView> {
    return StaffParkingSlotView.from(await this.parking.createSlot(dto));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({ summary: 'Change a parking slot’s code or place' })
  @ApiOkResponse({ type: StaffParkingSlotView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateParkingSlotDto,
  ): Promise<StaffParkingSlotView> {
    return StaffParkingSlotView.from(await this.parking.updateSlot(id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Take a parking slot away' })
  @ApiNoContentResponse()
  async remove(@Param('id', parseId()) id: string): Promise<void> {
    await this.parking.deleteSlot(id);
  }
}

/** The compound's visitor parking areas, for the staff (ADR 0045). */
@ApiArea('parking')
@RequirePermissions('vehicles.manage')
@Controller('staff/visitor-parking-areas')
export class VisitorAreasController {
  constructor(private readonly parking: StaffParkingService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the visitor parking areas, retired ones included' })
  @ApiOkResponse({ type: ListOf(VisitorParkingAreaView) })
  async list(): Promise<ListResponse<VisitorParkingAreaView>> {
    return bounded(await this.parking.areas(), (a) =>
      VisitorParkingAreaView.from(a),
    );
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Create a visitor parking area' })
  @ApiCreatedResponse({ type: VisitorParkingAreaView })
  async create(@Body() dto: CreateVisitorAreaDto): Promise<VisitorParkingAreaView> {
    return VisitorParkingAreaView.from(await this.parking.createArea(dto));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({ summary: 'Rename, resize or retire a visitor parking area' })
  @ApiOkResponse({ type: VisitorParkingAreaView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateVisitorAreaDto,
  ): Promise<VisitorParkingAreaView> {
    return VisitorParkingAreaView.from(await this.parking.updateArea(id, dto));
  }
}

/** A day's visitor parking bookings, for the staff (ADR 0045). */
@ApiArea('parking')
@RequirePermissions('vehicles.manage')
@Controller('staff/visitor-parking-bookings')
export class StaffVisitorParkingController {
  constructor(private readonly parking: StaffParkingService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List one day’s visitor parking bookings',
    description: 'Those touching the local day (today by default), cancelled ones included, soonest first.',
  })
  @ApiOkResponse({ type: ListOf(StaffVisitorParkingBookingView) })
  async list(
    @Query() q: StaffVisitorParkingQueryDto,
  ): Promise<ListResponse<StaffVisitorParkingBookingView>> {
    return bounded(await this.parking.bookings(q), (b) =>
      StaffVisitorParkingBookingView.from(b),
    );
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoStore()
  @ApiOperation({ summary: 'Cancel a visitor parking booking, with a reason code' })
  @ApiNoContentResponse()
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: StaffCancelVisitorParkingDto,
  ): Promise<void> {
    await this.parking.cancel(id, dto.reasonCode);
  }
}
