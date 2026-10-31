import { ApiProperty } from '@nestjs/swagger';
import type { BookingCompanion, Facility } from '@prisma/client';
import type { CompanionPlace } from '../companions.service';

/** A companion of a booking, as its booker sees it (ADR 0070): never a name. */
export class CompanionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  bookingId: string;
  @ApiProperty({
    enum: ['household', 'link'],
    enumName: 'CompanionVia',
    description:
      '`household`: invited by member id; `link`: joined by the share link.',
  })
  via: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  memberId: string | null;
  @ApiProperty({
    enum: ['invited', 'accepted', 'declined', 'removed', 'left', 'cancelled'],
    enumName: 'CompanionStatus',
    description:
      '`invited` and `accepted` hold a seat; `cancelled`: the booking ended (cancelled, rejected, expired or a no-show).',
  })
  status: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A code of `companionRemove`.',
  })
  removeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  static from(c: BookingCompanion): CompanionView {
    return {
      id: c.id,
      bookingId: c.bookingId,
      via: c.via,
      memberId: c.householdMemberId,
      status: c.status,
      removeReason: c.removeReason,
      createdAt: c.createdAt,
      respondedAt: c.respondedAt,
      endedAt: c.endedAt,
    };
  }
}

/** What a share link opens: the facility and the time, never the booker. */
export class BookingInviteView {
  @ApiProperty({ type: String, format: 'uuid' })
  facilityId: string;
  @ApiProperty({ type: String })
  facilityNameEn: string;
  @ApiProperty({ type: String })
  facilityNameAr: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  static from(p: {
    booking: { startsAt: Date; endsAt: Date };
    facility: Pick<Facility, 'id' | 'nameEn' | 'nameAr'>;
  }): BookingInviteView {
    return {
      facilityId: p.facility.id,
      facilityNameEn: p.facility.nameEn,
      facilityNameAr: p.facility.nameAr,
      startsAt: p.booking.startsAt,
      endsAt: p.booking.endsAt,
    };
  }
}

/** A place with someone else's booking, as the companion sees it. */
export class CompanionBookingView extends BookingInviteView {
  @ApiProperty({ type: CompanionView })
  companion: CompanionView;
  @ApiProperty({
    type: String,
    description:
      'The booking’s status: `pending` or `confirmed` while it holds.',
  })
  bookingStatus: string;

  static fromPlace(p: CompanionPlace): CompanionBookingView {
    return {
      ...BookingInviteView.from(p),
      companion: CompanionView.from(p.companion),
      bookingStatus: p.booking.status,
    };
  }
}

/** A new share link: the token, shown once. */
export class ShareLinkView {
  @ApiProperty({
    type: String,
    description:
      'Shown once; the link carries it. Any earlier link stops working.',
  })
  token: string;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'The booking’s start: the link works until then.',
  })
  expiresAt: Date;
}
