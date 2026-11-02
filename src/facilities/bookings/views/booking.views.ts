import { BUSY_LEVELS, type BusyLevel } from '../../busy/busy-levels';
import { ApiProperty } from '@nestjs/swagger';
import { HolidayFlagView } from '../../../core/holidays/views/holidays.views';
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

/** What a confirmed booking of a paying facility costs (ADR 0070). */
export interface BookingCharge {
  invoiceId: string;
  amount: string;
  status: 'open' | 'paid' | 'cancelled';
}

export class BookingChargeView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The unit’s invoice that owes it: paid as any invoice.',
  })
  invoiceId: string;
  @ApiProperty({ type: String, description: 'EGP, two decimals.' })
  amount: string;
  @ApiProperty({
    enum: ['open', 'paid', 'cancelled'],
    enumName: 'ChargeStatus',
    description:
      '`cancelled`: credited off — what was paid of it is the unit’s credit.',
  })
  status: 'open' | 'paid' | 'cancelled';
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
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A stay (ADR 0070): its first night, local `YYYY-MM-DD`.',
  })
  stayFromOn: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A stay: its check-out day, local.',
  })
  stayToOn: string | null;
  @ApiProperty({ type: Number })
  guests: number;
  @ApiProperty({
    type: Number,
    description:
      'Companions invited or accepted (ADR 0070): seats they hold beside the guests.',
  })
  companions: number;
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
  @ApiProperty({
    type: BookingChargeView,
    nullable: true,
    description:
      'What it costs, raised when it was confirmed (ADR 0070); null: free, or not confirmed.',
  })
  charge: BookingChargeView | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cancelled by a closure (ADR 0070): it may be rebooked once until then (`rebookOf`).',
  })
  rebookUntil: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  rebookOfId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(
    b: Booking & {
      occasion?: BookingOccasion | null;
      charge?: BookingCharge | null;
    },
    accountId: string,
  ): BookingView {
    return {
      id: b.id,
      facilityId: b.facilityId,
      unitId: b.unitId,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      stayFromOn: b.stayFromOn?.toISOString().slice(0, 10) ?? null,
      stayToOn: b.stayToOn?.toISOString().slice(0, 10) ?? null,
      guests: b.guests,
      companions: b.companions,
      peak: b.peak,
      status: b.status,
      mine: b.bookedById === accountId,
      rejectReason: b.rejectReason,
      cancelledSide: b.cancelledSide,
      cancelReason: b.cancelReason,
      occasion: b.occasion ?? null,
      charge: b.charge ?? null,
      rebookUntil: b.rebookUntil,
      rebookOfId: b.rebookOfId,
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
  @ApiProperty({
    enum: BUSY_LEVELS,
    nullable: true,
    description:
      'How busy (ADR 0071): a level, never a count. Null when closed.',
  })
  busy: BusyLevel | null;
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
  @ApiProperty({
    type: HolidayFlagView,
    nullable: true,
    description:
      'The compound’s holiday that day (ADR 0084): a flag; the slots are as the facility’s hours make them.',
  })
  holiday: HolidayFlagView | null;
}
