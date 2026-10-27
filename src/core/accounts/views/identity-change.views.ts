import { ApiProperty } from '@nestjs/swagger';
import {
  IDENTITY_FIELDS,
  type IdentityChangeRead,
  type IdentityChangeReview,
} from '../identity-changes.service';

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

/** A name or phone change request (ADR 0062); the value only while pending. */
export class IdentityChangeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: IDENTITY_FIELDS })
  field: 'name' | 'phone';
  @ApiProperty({ enum: STATUSES })
  status: (typeof STATUSES)[number];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The value asked for; null once decided or withdrawn.',
  })
  newValue: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['not_verified', 'does_not_match_documents', 'other'],
    description: 'Why it was rejected.',
  })
  reasonCode: string | null;

  static from(r: IdentityChangeRead): IdentityChangeView {
    return {
      id: r.id,
      field: r.field,
      status: r.status,
      newValue: r.newValue,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      reasonCode: r.reasonCode,
    };
  }
}

/** A pending request as the management reviews it. */
export class IdentityChangeReviewView extends IdentityChangeView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, description: '`resident` or `family`.' })
  accountType: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The value the change replaces.',
  })
  currentValue: string | null;

  static fromReview(r: IdentityChangeReview): IdentityChangeReviewView {
    return {
      ...IdentityChangeView.from(r),
      accountId: r.accountId,
      accountType: r.accountType,
      currentValue: r.currentValue,
    };
  }
}
