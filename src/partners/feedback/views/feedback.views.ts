import { ApiProperty } from '@nestjs/swagger';
import type { PartnerRating } from '@prisma/client';
import { requestNumber } from '../../requests/request-rules';
import type { ComplaintRead } from '../complaints.service';
import type { RatingSummary, StaffRating } from '../ratings.service';

/** A request's rating, as its requester reads it. */
export class RatingView {
  @ApiProperty({ type: Number, minimum: 1, maximum: 5 })
  stars: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'As written; null once erased.',
  })
  comment: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: PartnerRating): RatingView {
    return { stars: r.stars, comment: r.comment, createdAt: r.createdAt };
  }
}

/** A rating as the staff read it: by the request's number, never by who rated. */
export class StaffRatingView extends RatingView {
  @ApiProperty({ type: String, format: 'uuid' })
  requestId: string;
  @ApiProperty({ type: String, example: 'SR-000123' })
  requestNumber: string;
  @ApiProperty({ type: String, format: 'uuid' })
  partnerId: string;

  static fromStaff(r: StaffRating): StaffRatingView {
    return {
      ...RatingView.from(r),
      requestId: r.requestId,
      requestNumber: requestNumber(r.requestNumber),
      partnerId: r.partnerId,
    };
  }
}

/** A partner's ratings in short. */
export class RatingSummaryView {
  @ApiProperty({ type: String, example: '4.3', description: 'One decimal.' })
  average: string;
  @ApiProperty({ type: Number })
  count: number;

  static from(s: RatingSummary): RatingSummaryView {
    return { average: s.average.toFixed(1), count: s.count };
  }
}

export class ComplaintPartnerView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
}

/**
 * A complaint against a partner (ADR 0060): what it asks, the management
 * request it is (its conversation is there), and the decision.
 */
export class ComplaintView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  requestId: string;
  @ApiProperty({ type: String, example: 'SR-000123' })
  requestNumber: string;
  @ApiProperty({ type: ComplaintPartnerView })
  partner: ComplaintPartnerView;
  @ApiProperty({
    type: String,
    description: 'From the closed list `partnerComplaint`.',
  })
  reason: string;
  @ApiProperty({
    type: String,
    description: 'From the closed list `partnerCompensationAsk`.',
  })
  compensationAsk: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP asked, with a refund or damages; never paid here.',
  })
  requestedAmount: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The management request it is: the conversation is there.',
  })
  managementRequestId: string;
  @ApiProperty({ type: String, example: 'MR-000123' })
  managementRequestNumber: string;
  @ApiProperty({
    enum: ['upheld', 'not_upheld'],
    enumName: 'PartnerComplaintOutcome',
    nullable: true,
  })
  outcome: 'upheld' | 'not_upheld' | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'From the closed list `partnerCompensationDecision`: what the management arranges. A credit note is issued in finance.',
  })
  compensation: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(c: ComplaintRead): ComplaintView {
    return {
      id: c.id,
      requestId: c.requestId,
      requestNumber: requestNumber(c.requestNumber),
      partner: c.partner,
      reason: c.reason,
      compensationAsk: c.compensationAsk,
      requestedAmount: c.requestedAmount?.toFixed(2) ?? null,
      managementRequestId: c.managementRequestId,
      managementRequestNumber: c.managementRequestNumber,
      outcome: c.outcome as ComplaintView['outcome'],
      compensation: c.compensation,
      decidedAt: c.decidedAt,
      createdAt: c.createdAt,
    };
  }
}
