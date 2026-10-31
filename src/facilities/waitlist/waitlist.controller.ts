import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BookingView } from '../bookings/views/booking.views';
import { JoinWaitlistDto } from './dto/waitlist.dto';
import { WaitlistEntryView } from './views/waitlist.views';
import { WaitlistService } from './waitlist.service';

/** The booking waitlist, on the residents' side (ADR 0070). */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller()
export class WaitlistController {
  constructor(
    private readonly waitlist: WaitlistService,
    private readonly ctx: RequestContext,
  ) {}

  @Post('facilities/:id/waitlist')
  @NoStore()
  @ApiOperation({
    summary: 'Wait for a full slot',
    description:
      'For a unit the caller books for: a full slot (BOOKING_SLOT_AVAILABLE while it has room), at least 15 minutes ahead, at most three at once (WAITLIST_LIMIT_REACHED), once per slot (WAITLIST_EXISTS). What frees room is offered in the order of joining and held for the compound’s `waitlistHoldMinutes`.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: WaitlistEntryView })
  async join(
    @Param('id', parseId()) id: string,
    @Body() dto: JoinWaitlistDto,
  ): Promise<WaitlistEntryView> {
    return WaitlistEntryView.from(await this.waitlist.join(id, dto));
  }

  @Get('me/waitlist')
  @NoStore()
  @ApiOperation({ summary: 'List the caller’s waitlist entries, newest first' })
  @ApiOkResponse({ type: ListOf(WaitlistEntryView) })
  async mine(): Promise<ListResponse<WaitlistEntryView>> {
    return bounded(await this.waitlist.mine(), (e) =>
      WaitlistEntryView.from(e),
    );
  }

  @Post('booking-waitlist/:id/leave')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({
    summary: 'Leave a waitlist',
    description: 'An offer it held goes to the next in line.',
  })
  @ApiOkResponse({ type: WaitlistEntryView })
  async leave(@Param('id', parseId()) id: string): Promise<WaitlistEntryView> {
    return WaitlistEntryView.from(await this.waitlist.leave(id));
  }

  @Post('booking-waitlist/:id/claim')
  @NoStore()
  @ApiOperation({
    summary: 'Book the place an offer holds',
    description:
      'A live offer (WAITLIST_OFFER_INVALID otherwise), booked as any booking is decided — the quotas included — taking only its own hold.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: BookingView })
  async claim(@Param('id', parseId()) id: string): Promise<BookingView> {
    return BookingView.from(await this.waitlist.claim(id), this.ctx.accountId);
  }
}
