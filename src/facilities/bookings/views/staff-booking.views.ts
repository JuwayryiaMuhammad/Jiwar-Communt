import { ApiProperty } from '@nestjs/swagger';
import {
  BookingSide,
  BookingStatus,
  FacilityCapacityUnit,
} from '@prisma/client';
import type { FacilityDay, StaffBooking } from '../staff-bookings.service';

/** Who made a booking, as the staff see them: a name, or none once erased. */
export class BookingPersonView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once erased.',
  })
  fullName: string | null;
  @ApiProperty({ type: Boolean })
  erased: boolean;
}

/** A booking as the staff see it: its unit and its booker by name. */
export class StaffBookingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  facilityId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: BookingPersonView })
  bookedBy: BookingPersonView;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: Number })
  guests: number;
  @ApiProperty({ type: Number, description: 'The booker and the guests.' })
  partySize: number;
  @ApiProperty({ type: Boolean })
  peak: boolean;
  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Approved or rejected at.',
  })
  decidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  rejectReason: string | null;
  @ApiProperty({ enum: BookingSide, enumName: 'BookingSide', nullable: true })
  cancelledSide: BookingSide | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  noShowMarkedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from({
    booking: b,
    unitCode,
    bookedBy,
  }: StaffBooking): StaffBookingView {
    return {
      id: b.id,
      facilityId: b.facilityId,
      unitId: b.unitId,
      unitCode,
      bookedBy: { ...bookedBy },
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      guests: b.guests,
      partySize: b.partySize,
      peak: b.peak,
      status: b.status,
      decidedAt: b.decidedAt,
      rejectReason: b.rejectReason,
      cancelledSide: b.cancelledSide,
      cancelReason: b.cancelReason,
      cancelledAt: b.cancelledAt,
      noShowMarkedAt: b.noShowMarkedAt,
      createdAt: b.createdAt,
    };
  }
}

/** A slot of the day, with how much of it is taken. */
export class FacilityDaySlotView {
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: Boolean })
  peak: boolean;
  @ApiProperty({
    type: Number,
    description: 'Bookings, or people, holding it (pending and confirmed).',
  })
  taken: number;
}

/** A facility's local day for the staff: its slots and every booking of it. */
export class FacilityDayView {
  @ApiProperty({ type: String })
  date: string;
  @ApiProperty({ type: Number })
  capacity: number;
  @ApiProperty({ enum: FacilityCapacityUnit, enumName: 'FacilityCapacityUnit' })
  capacityUnit: FacilityCapacityUnit;
  @ApiProperty({
    type: [FacilityDaySlotView],
    description: 'The slots of the day as the hours cut them now.',
  })
  slots: FacilityDaySlotView[];
  @ApiProperty({
    type: [StaffBookingView],
    description:
      'Every booking that overlaps the day, whatever its status, in order of start.',
  })
  bookings: StaffBookingView[];

  static from(d: FacilityDay): FacilityDayView {
    return {
      date: d.date,
      capacity: d.rules.capacity,
      capacityUnit: d.rules.capacityUnit,
      slots: d.slots.map((s) => ({
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        peak: s.peak,
        taken: s.taken,
      })),
      bookings: d.bookings.map((b) => StaffBookingView.from(b)),
    };
  }
}
