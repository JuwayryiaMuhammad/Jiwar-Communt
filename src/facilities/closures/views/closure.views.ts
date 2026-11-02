import { ApiProperty } from '@nestjs/swagger';
import type { FacilityClosure } from '@prisma/client';
import type { ClosurePreview, PreviewedBooking } from '../closures.service';

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

/** A booking's fee, as a closure would credit it (ADR 0084). */
export class PreviewedChargeView {
  @ApiProperty({ type: String, example: '150.00' })
  amount: string;
  @ApiProperty({ enum: ['open', 'paid'] })
  status: 'open' | 'paid';
  @ApiProperty({
    enum: ['invoice_credited', 'unit_credit'],
    description:
      '`invoice_credited`: the unpaid invoice is credited, nothing owed; `unit_credit`: the money paid goes to the unit’s credit (cash back only through the manager’s refund).',
  })
  outcome: 'invoice_credited' | 'unit_credit';
}

/** A booking a closure would cancel (ADR 0084). */
export class PreviewedBookingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ enum: ['pending', 'confirmed'] })
  status: string;
  @ApiProperty({ type: PreviewedChargeView, nullable: true })
  charge: PreviewedChargeView | null;

  static from(b: PreviewedBooking): PreviewedBookingView {
    return { ...b, charge: b.charge ? { ...b.charge } : null };
  }
}

/** What a closure would do now (ADR 0084): no-store. */
export class ClosurePreviewView {
  @ApiProperty({
    type: [PreviewedBookingView],
    description: 'Soonest first. Never a booker or anyone else.',
  })
  bookings: PreviewedBookingView[];
  @ApiProperty({ type: String, example: '0.00' })
  invoicesCredited: string;
  @ApiProperty({ type: String, example: '0.00' })
  unitCredit: string;
  @ApiProperty({
    type: String,
    description:
      'Send it with the closure: it then applies exactly this, or refuses (FACILITY_CLOSURE_PREVIEW_STALE).',
  })
  previewToken: string;

  static from(p: ClosurePreview): ClosurePreviewView {
    return {
      bookings: p.bookings.map((b) => PreviewedBookingView.from(b)),
      invoicesCredited: p.invoicesCredited,
      unitCredit: p.unitCredit,
      previewToken: p.previewToken,
    };
  }
}
