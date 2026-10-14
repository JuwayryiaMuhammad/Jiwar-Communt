import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  FacilityDayQueryDto,
  RejectBookingDto,
  StaffBookingsQueryDto,
  StaffCancelBookingDto,
} from './dto/bookings.dto';
import { StaffBookingsService } from './staff-bookings.service';
import { FacilityDayView, StaffBookingView } from './views/staff-booking.views';

/** The compound's bookings, for the staff who work them (ADR 0044). */
@ApiArea('bookings')
@RequirePermissions('bookings.handle')
@Controller('staff/bookings')
export class StaffBookingsController {
  constructor(private readonly bookings: StaffBookingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the compound’s bookings',
    description: 'Soonest first. `status=pending` is the approvals queue.',
  })
  @ApiOkResponse({ type: ListOf(StaffBookingView) })
  async list(
    @Query() q: StaffBookingsQueryDto,
  ): Promise<ListResponse<StaffBookingView>> {
    return toList(await this.bookings.list(q), (b) => StaffBookingView.from(b));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a booking with its unit and booker' })
  @ApiOkResponse({ type: StaffBookingView })
  async get(@Param('id', parseId()) id: string): Promise<StaffBookingView> {
    return StaffBookingView.from(await this.bookings.get(id));
  }

  @Post(':id/approve')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({
    summary: 'Approve a pending booking',
    description:
      'Before its start (BOOKING_WINDOW_PASSED), and only while the slot’s confirmed bookings leave room under the capacity as it is now (BOOKING_SLOT_FULL).',
  })
  @ApiNoContentResponse()
  async approve(@Param('id', parseId()) id: string): Promise<void> {
    await this.bookings.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Reject a pending booking, with a reason code' })
  @ApiNoContentResponse()
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: RejectBookingDto,
  ): Promise<void> {
    await this.bookings.reject(id, dto.reasonCode);
  }

  @Post(':id/no-show')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({
    summary: 'Mark a confirmed booking a no-show',
    description:
      'After its slot ended (BOOKING_NOT_OVER) and within 72 hours (BOOKING_NO_SHOW_TOO_LATE). Final. Enough no-shows suspend the unit from booking.',
  })
  @ApiNoContentResponse()
  async noShow(@Param('id', parseId()) id: string): Promise<void> {
    await this.bookings.markNoShow(id);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel a booking, with a reason code',
    description:
      'A pending or confirmed booking that has not ended, whatever the facility’s cutoff.',
  })
  @ApiNoContentResponse()
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: StaffCancelBookingDto,
  ): Promise<void> {
    await this.bookings.cancel(id, dto.reasonCode);
  }
}

/** A facility's day, for the staff who work its bookings (ADR 0044). */
@ApiArea('bookings')
@RequirePermissions('bookings.handle')
@Controller('staff/facilities')
export class FacilityDayController {
  constructor(private readonly bookings: StaffBookingsService) {}

  @Get(':id/day')
  @NoStore()
  @ApiOperation({ summary: 'Get a facility’s day: its slots and bookings' })
  @ApiOkResponse({ type: FacilityDayView })
  async day(
    @Param('id', parseId()) id: string,
    @Query() q: FacilityDayQueryDto,
  ): Promise<FacilityDayView> {
    return FacilityDayView.from(await this.bookings.day(id, q.date));
  }
}
