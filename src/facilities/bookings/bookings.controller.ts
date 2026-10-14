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
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BookingsService } from './bookings.service';
import {
  CancelBookingDto,
  CreateBookingDto,
  FacilitySlotsQueryDto,
  UnitBookingsQueryDto,
} from './dto/bookings.dto';
import { BookingView, FacilitySlotsView } from './views/booking.views';

/** A facility's slots of a day, as residents see them (ADR 0044). */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller('facilities')
export class FacilitySlotsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get(':id/slots')
  @NoStore()
  @ApiOperation({ summary: 'List a facility’s slots of a day, free or full' })
  @ApiOkResponse({ type: FacilitySlotsView })
  async slots(
    @Param('id', parseId()) id: string,
    @Query() q: FacilitySlotsQueryDto,
  ): Promise<FacilitySlotsView> {
    const { date, slots } = await this.bookings.slots(id, q.date, q.unitId);
    return {
      date,
      slots: slots.map((s) => ({
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        peak: s.peak,
        state: s.state,
        mine: s.mine,
      })),
    };
  }
}

/** A unit's bookings: book, and list what the caller sees (ADR 0044). */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller('units/:unitId/bookings')
export class UnitBookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly ctx: RequestContext,
  ) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Book a facility’s slot for the unit' })
  @Idempotent()
  @ApiCreatedResponse({ type: BookingView })
  async book(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateBookingDto,
  ): Promise<BookingView> {
    return BookingView.from(
      await this.bookings.book(unitId, dto),
      this.ctx.accountId,
    );
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the unit’s bookings the caller sees',
    description:
      'The caller’s own; the unit’s primary sees every booking of the unit, except during a separation.',
  })
  @ApiOkResponse({ type: ListOf(BookingView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: UnitBookingsQueryDto,
  ): Promise<ListResponse<BookingView>> {
    return toList(await this.bookings.forUnit(unitId, q), (b) =>
      BookingView.from(b, this.ctx.accountId),
    );
  }
}

/** One booking the caller sees (ADR 0044). */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly ctx: RequestContext,
  ) {}

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a booking' })
  @ApiOkResponse({ type: BookingView })
  async get(@Param('id', parseId()) id: string): Promise<BookingView> {
    return BookingView.from(await this.bookings.get(id), this.ctx.accountId);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel a booking',
    description:
      'Its booker or the unit’s primary: a pending booking at any time, a confirmed one until the facility’s cutoff (BOOKING_CANCEL_CUTOFF_PASSED).',
  })
  @ApiNoContentResponse()
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelBookingDto,
  ): Promise<void> {
    await this.bookings.cancel(id, dto.reasonCode);
  }
}
