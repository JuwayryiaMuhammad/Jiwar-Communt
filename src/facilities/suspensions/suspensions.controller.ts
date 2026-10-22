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
import { LiftSuspensionDto, SuspensionsQueryDto } from './dto/suspensions.dto';
import { BOARD_APPEAL_DAYS, SuspensionsService } from './suspensions.service';
import {
  BookingStandingView,
  BookingSuspensionNoticeView,
  BookingSuspensionView,
} from './views/suspension.views';

/** Where a unit stands with its bookings (ADR 0044). */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller('units/:unitId/booking-standing')
export class BookingStandingController {
  constructor(private readonly suspensions: SuspensionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Get whether the unit may book, or until when it may not',
  })
  @ApiOkResponse({ type: BookingStandingView })
  async get(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<BookingStandingView> {
    const { suspension, now } = await this.suspensions.standing(unitId);
    const until =
      suspension && !suspension.boardAppealAt
        ? new Date(
            suspension.startsAt.getTime() + BOARD_APPEAL_DAYS * 86_400_000,
          )
        : null;
    return {
      suspension: suspension && BookingSuspensionNoticeView.from(suspension),
      boardAppealUntil: until && now < until ? until : null,
      boardAppealAt: suspension?.boardAppealAt ?? null,
    };
  }
}

/** Units suspended from booking, for the staff who work the bookings (ADR 0044). */
@ApiArea('bookings')
@RequirePermissions('bookings.handle')
@Controller('staff/booking-suspensions')
export class BookingSuspensionsController {
  constructor(private readonly suspensions: SuspensionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the suspensions, latest first' })
  @ApiOkResponse({ type: ListOf(BookingSuspensionView) })
  async list(
    @Query() q: SuspensionsQueryDto,
  ): Promise<ListResponse<BookingSuspensionView>> {
    return toList(
      await this.suspensions.list({ ...q, inForce: q.inForce === 'true' }),
      (s) => BookingSuspensionView.from(s),
    );
  }

  @Post(':id/lift')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({
    summary: 'Lift a suspension in force, with a reason code',
    description: 'BOOKING_SUSPENSION_NOT_IN_FORCE once it is over or lifted.',
  })
  @ApiNoContentResponse()
  async lift(
    @Param('id', parseId()) id: string,
    @Body() dto: LiftSuspensionDto,
  ): Promise<void> {
    await this.suspensions.lift(id, dto.reasonCode);
  }
}
