import { ApiProperty } from '@nestjs/swagger';
import type { BookingWaitlistEntry } from '@prisma/client';

/** A wait for a full slot (ADR 0070), as its account sees it. */
export class WaitlistEntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  facilityId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: Number, description: 'The booker and the guests.' })
  partySize: number;
  @ApiProperty({
    enum: ['waiting', 'offered', 'booked', 'lapsed', 'left', 'closed'],
    enumName: 'WaitlistStatus',
    description:
      '`offered`: a place is held until `offerExpiresAt` — claim it; `booked`: claimed (`bookingId`).',
  })
  status: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  offerExpiresAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  bookingId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  static from(e: BookingWaitlistEntry): WaitlistEntryView {
    return {
      id: e.id,
      facilityId: e.facilityId,
      unitId: e.unitId,
      startsAt: e.startsAt,
      partySize: e.partySize,
      status: e.status,
      offerExpiresAt: e.offerExpiresAt,
      bookingId: e.bookingId,
      createdAt: e.createdAt,
      endedAt: e.endedAt,
    };
  }
}
