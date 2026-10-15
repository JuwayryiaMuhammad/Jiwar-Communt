import { ApiProperty } from '@nestjs/swagger';
import { RefundChannel } from '@prisma/client';
import { StaffRefView } from '../../payments/views/payment.views';

/** Which payment's free money a refund took. */
export class RefundSourceView {
  @ApiProperty({ type: String, format: 'uuid' })
  paymentId: string;
  @ApiProperty({ type: String, example: 'RC-000042' })
  receiptNumber: string;
  @ApiProperty({ type: String })
  amount: string;
}

export class RefundReversalView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'REASON_CODES.refundReverse' })
  reasonCode: string;
  @ApiProperty({ type: StaffRefView })
  recordedBy: StaffRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** A refund of a unit's credit (ADR 0048), as the staff read it. */
export class RefundView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'RF-000007' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, enum: ['EGP'] })
  currency: string;
  @ApiProperty({ enum: RefundChannel, enumName: 'RefundChannel' })
  channel: RefundChannel;
  @ApiProperty({ type: String, nullable: true })
  reference: string | null;
  @ApiProperty({ type: String, format: 'date', description: 'Local day.' })
  refundedOn: string;
  @ApiProperty({ type: StaffRefView })
  recordedBy: StaffRefView;
  @ApiProperty({
    type: [RefundSourceView],
    description: 'Newest payment first.',
  })
  sources: RefundSourceView[];
  @ApiProperty({
    type: RefundReversalView,
    nullable: true,
    description: 'Reversed: the money is the unit’s credit again.',
  })
  reversal: RefundReversalView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
