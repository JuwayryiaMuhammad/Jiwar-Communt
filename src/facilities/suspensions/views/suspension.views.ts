import { ApiProperty } from '@nestjs/swagger';
import type { BookingSuspension } from '@prisma/client';
import type { StaffSuspension } from '../suspensions.service';

/** A unit's suspension from booking, as its people see it. */
export class BookingSuspensionNoticeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'No new booking until then.',
  })
  endsAt: Date;

  static from(s: BookingSuspension): BookingSuspensionNoticeView {
    return { id: s.id, startsAt: s.startsAt, endsAt: s.endsAt };
  }
}

/** Where the unit stands with its bookings. */
export class BookingStandingView {
  @ApiProperty({
    type: BookingSuspensionNoticeView,
    nullable: true,
    description: 'The suspension in force, or null: the unit may book.',
  })
  suspension: BookingSuspensionNoticeView | null;
}

/** A suspension as the staff see it. */
export class BookingSuspensionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: Number, description: 'The no-shows that started it.' })
  noShowCount: number;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The no-show that reached the threshold.',
  })
  triggerBookingId: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  liftedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A code of `bookingSuspensionLift`.',
  })
  liftReasonCode: string | null;

  static from({
    suspension: s,
    unitCode,
  }: StaffSuspension): BookingSuspensionView {
    return {
      ...BookingSuspensionNoticeView.from(s),
      unitId: s.unitId,
      unitCode,
      noShowCount: s.noShowCount,
      triggerBookingId: s.triggerBookingId,
      liftedAt: s.liftedAt,
      liftReasonCode: s.liftReasonCode,
    };
  }
}
