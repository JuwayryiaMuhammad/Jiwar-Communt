import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { CompanionsService } from './companions.service';
import {
  BookingInviteDto,
  InviteCompanionDto,
  RemoveCompanionDto,
} from './dto/companions.dto';
import {
  BookingInviteView,
  CompanionBookingView,
  CompanionView,
  ShareLinkView,
} from './views/companion.views';

/** A booking's companions, on its booker's side (ADR 0070). */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller('bookings/:id')
export class BookingCompanionsController {
  constructor(private readonly companions: CompanionsService) {}

  @Post('companions')
  @NoStore()
  @ApiOperation({
    summary: 'Invite one of the household to come along',
    description:
      'The booker: a household member of the unit with an account, invited, holding a seat until they decline. Guests and companions stay within max_guests (BOOKING_PARTY_FULL); a slot counted in people needs room (BOOKING_SLOT_FULL).',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: CompanionBookingView })
  async invite(
    @Param('id', parseId()) id: string,
    @Body() dto: InviteCompanionDto,
  ): Promise<CompanionBookingView> {
    return CompanionBookingView.fromPlace(
      await this.companions.invite(id, dto.memberId),
    );
  }

  @Get('companions')
  @NoStore()
  @ApiOperation({ summary: 'List a booking’s companions' })
  @ApiOkResponse({ type: ListOf(CompanionView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<CompanionView>> {
    return bounded(await this.companions.list(id), (c) =>
      CompanionView.from(c),
    );
  }

  @Post('share-link')
  @NoStore()
  @ApiOperation({
    summary: 'Make a new share link',
    description:
      'The booker: anyone of the compound who opens it until the start may join. Any earlier link stops working.',
  })
  @ApiCreatedResponse({ type: ShareLinkView })
  shareLink(@Param('id', parseId()) id: string): Promise<ShareLinkView> {
    return this.companions.shareLink(id);
  }

  @Delete('companions/:companionId')
  @NoStore()
  @ApiOperation({
    summary: 'Remove a companion',
    description:
      'The booker, with a code in the query (`?reasonCode=`, a DELETE takes no body): the seat is freed.',
  })
  @ApiOkResponse({ type: CompanionView })
  async remove(
    @Param('id', parseId()) id: string,
    @Param('companionId', parseId('companionId')) companionId: string,
    @Query() dto: RemoveCompanionDto,
  ): Promise<CompanionView> {
    return CompanionView.from(
      await this.companions.remove(id, companionId, dto.reasonCode),
    );
  }

  @Post('companions/me/leave')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Leave a booking one came along to' })
  @ApiOkResponse({ type: CompanionBookingView })
  async leave(
    @Param('id', parseId()) id: string,
  ): Promise<CompanionBookingView> {
    return CompanionBookingView.fromPlace(await this.companions.leave(id));
  }
}

/** Share links and the caller's places with others' bookings (ADR 0070). */
@ApiArea('bookings')
@RequirePermissions('facilities.book')
@Controller()
export class CompanionPlacesController {
  constructor(private readonly companions: CompanionsService) {}

  @Post('booking-invites/preview')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({
    summary: 'See what a share link opens',
    description:
      'The facility and the time, never the booker (BOOKING_INVITE_INVALID).',
  })
  @ApiOkResponse({ type: BookingInviteView })
  async preview(@Body() dto: BookingInviteDto): Promise<BookingInviteView> {
    return BookingInviteView.from(await this.companions.preview(dto.token));
  }

  @Post('booking-invites/accept')
  @NoStore()
  @ApiOperation({
    summary: 'Join a booking by its share link',
    description:
      'Accepted at once. Refused to its booker (COMPANION_IS_BOOKER), to an account banned from the facility (FACILITY_BANNED), while its unit is suspended (BOOKINGS_SUSPENDED), and when the party or the slot is full.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: CompanionBookingView })
  async join(@Body() dto: BookingInviteDto): Promise<CompanionBookingView> {
    return CompanionBookingView.fromPlace(
      await this.companions.join(dto.token),
    );
  }

  @Get('me/companion-bookings')
  @NoStore()
  @ApiOperation({
    summary: 'List the bookings the caller comes along to',
    description: 'Live places first, then soonest first; at most 100.',
  })
  @ApiOkResponse({ type: ListOf(CompanionBookingView) })
  async mine(): Promise<ListResponse<CompanionBookingView>> {
    return bounded(await this.companions.mine(), (p) =>
      CompanionBookingView.fromPlace(p),
    );
  }

  @Post('me/companion-bookings/:companionId/accept')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Accept a household invitation' })
  @ApiOkResponse({ type: CompanionBookingView })
  async accept(
    @Param('companionId', parseId('companionId')) companionId: string,
  ): Promise<CompanionBookingView> {
    return CompanionBookingView.fromPlace(
      await this.companions.accept(companionId),
    );
  }

  @Post('me/companion-bookings/:companionId/decline')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Decline a household invitation' })
  @ApiOkResponse({ type: CompanionBookingView })
  async decline(
    @Param('companionId', parseId('companionId')) companionId: string,
  ): Promise<CompanionBookingView> {
    return CompanionBookingView.fromPlace(
      await this.companions.decline(companionId),
    );
  }
}
