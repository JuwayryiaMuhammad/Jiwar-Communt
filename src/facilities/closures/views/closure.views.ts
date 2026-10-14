import { ApiProperty } from '@nestjs/swagger';
import type { FacilityClosure } from '@prisma/client';

/** A closure as residents see it: when, and why, as a code. */
export class FacilityClosureNoticeView {
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: String, description: 'A code of `facilityClosure`.' })
  reasonCode: string;

  static from(c: FacilityClosure): FacilityClosureNoticeView {
    return { startsAt: c.startsAt, endsAt: c.endsAt, reasonCode: c.reasonCode };
  }
}

/** A closure as the staff see it. */
export class FacilityClosureView extends FacilityClosureNoticeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  facilityId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  liftedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A code of `facilityClosureLift`.',
  })
  liftReasonCode: string | null;

  static from(c: FacilityClosure): FacilityClosureView {
    return {
      ...FacilityClosureNoticeView.from(c),
      id: c.id,
      facilityId: c.facilityId,
      createdAt: c.createdAt,
      liftedAt: c.liftedAt,
      liftReasonCode: c.liftReasonCode,
    };
  }
}

/** A new closure, and how many bookings it cancelled. */
export class FacilityClosureCreatedView extends FacilityClosureView {
  @ApiProperty({ type: Number, description: 'Bookings it cancelled.' })
  cancelledBookings: number;
}
