import { ApiProperty } from '@nestjs/swagger';
import type { ClubRequestRead } from '../club-requests.service';

export class ClubRequestChargeView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The unit’s `club` invoice that owes the price.',
  })
  invoiceId: string;
  @ApiProperty({
    enum: ['open', 'paid', 'cancelled'],
    enumName: 'ChargeStatus',
  })
  status: 'open' | 'paid' | 'cancelled';
}

/**
 * A club membership request (ADR 0070): the plan, its price when asked,
 * where it stands, and the invoice that owes it. Never who asked by name.
 */
export class ClubRequestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  planId: string;
  @ApiProperty({ type: String, description: 'EGP, two decimals.' })
  amount: string;
  @ApiProperty({
    enum: ['requested', 'paid', 'cancelled'],
    enumName: 'ClubRequestStatus',
    description:
      '`paid`: the membership started or was extended (`paymentId`, a payment of the membership).',
  })
  status: string;
  @ApiProperty({ type: ClubRequestChargeView, nullable: true })
  charge: ClubRequestChargeView | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  paymentId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A code of `clubRequestCancel`.',
  })
  cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;

  static from(r: ClubRequestRead): ClubRequestView {
    return {
      id: r.id,
      unitId: r.unitId,
      planId: r.planId,
      amount: r.amount.toFixed(2),
      status: r.status,
      charge: r.charge,
      paymentId: r.paymentRecordId,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt,
      paidAt: r.paidAt,
      cancelledAt: r.cancelledAt,
    };
  }
}

/** As the club's staff see it: with the unit's code. */
export class StaffClubRequestView extends ClubRequestView {
  @ApiProperty({ type: String })
  unitCode: string;

  static fromStaff(r: ClubRequestRead & { unitCode: string }) {
    return { ...ClubRequestView.from(r), unitCode: r.unitCode };
  }
}
