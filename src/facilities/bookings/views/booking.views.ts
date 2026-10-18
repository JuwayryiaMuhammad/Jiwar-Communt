import { ApiProperty } from '@nestjs/swagger';
import { BookingSide, BookingStatus, type Booking } from '@prisma/client';

/** A booking's occasion: one of the unit's children (ADR 0054). */
export interface BookingOccasion {
  memberId: string;
  firstName: string | null;
}

export class BookingOccasionView {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The child's first name; null once they are no longer the unit's.",
  })
  firstName: string | null;
}

/**
 * A booking as residents see it: the unit's, never who of the household
 * made it beyond `mine`, and never an account id.
 */
export class BookingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  facilityId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: Number })
  guests: number;
  @ApiProperty({
    type: Boolean,
    description:
      'The slot is in a peak time: it counts towards the peak quota.',
  })
  peak: boolean;
  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;
  @ApiProperty({ type: Boolean, description: 'The caller made it.' })
  mine: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A code of `bookingReject`.',
  })
  rejectReason: string | null;
  @ApiProperty({ enum: BookingSide, enumName: 'BookingSide', nullable: true })
  cancelledSide: BookingSide | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A code of `bookingResidentCancel`, `bookingStaffCancel` or `bookingSystemCancel`, by side.',
  })
  cancelReason: string | null;
  @ApiProperty({
    type: BookingOccasionView,
    nullable: true,
    description: 'The child whose occasion it is (a birthday space), or null.',
  })
  occasion: BookingOccasionView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(
    b: Booking & { occasion?: BookingOccasion | null },
    accountId: string,
  ): BookingView {
    return {
      id: b.id,
      facilityId: b.facilityId,
      unitId: b.unitId,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      guests: b.guests,
      peak: b.peak,
      status: b.status,
      mine: b.bookedById === accountId,
      rejectReason: b.rejectReason,
      cancelledSide: b.cancelledSide,
      cancelReason: b.cancelReason,
      occasion: b.occasion ?? null,
      createdAt: b.createdAt,
    };
  }
}

/** A slot as residents see it: free or full, never how full or by whom. */
export class FacilitySlotView {
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: Boolean })
  peak: boolean;
  @ApiProperty({
    enum: ['free', 'full', 'closed'],
    enumName: 'FacilitySlotState',
    description: '`closed`: a closure of the facility covers it.',
  })
  state: 'free' | 'full' | 'closed';
  @ApiProperty({
    type: Boolean,
    description: 'The unit asked about (`unitId`) holds this slot.',
  })
  mine: boolean;
}

export class FacilitySlotsView {
  @ApiProperty({ type: String, description: 'The local day, `YYYY-MM-DD`.' })
  date: string;
  @ApiProperty({
    type: [FacilitySlotView],
    description:
      'The slots of the day that may be booked now, in order. Too soon and too far are left out.',
  })
  slots: FacilitySlotView[];
}
