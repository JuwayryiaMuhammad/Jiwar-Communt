import { ApiProperty } from '@nestjs/swagger';
import { REASON_CODES } from '../../../core/common/reasons';
import { PLAN_REQUEST_STATUSES } from '../plan-requests.service';

/** A payment plan a resident asked for (ADR 0069): codes and ids, no names. */
export class PlanRequestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  invoiceId: string;
  @ApiProperty({ type: String, example: 'INV-000123' })
  invoiceNumber: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: Number })
  months: number;
  @ApiProperty({
    enum: PLAN_REQUEST_STATUSES,
    enumName: 'PlanRequestStatus',
    description:
      '`lapsed`: it waited on an invoice that was paid, credited or split meanwhile.',
  })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.planRequestDecline,
    enumName: 'PlanRequestDeclineReason',
    nullable: true,
  })
  declineReason: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The instalment plan an accepted request made.',
  })
  planId: string | null;
}

export class PlanSettingsView {
  @ApiProperty({ type: Number })
  planMaxMonths: number;
  @ApiProperty({ type: String, nullable: true })
  planOfferMinAmount: string | null;
  @ApiProperty({ type: Boolean })
  duesNotice: boolean;
}
