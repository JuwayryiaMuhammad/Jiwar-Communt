import { ApiProperty } from '@nestjs/swagger';
import { HouseholdRelation } from '@prisma/client';
import type { MemberToReview } from '../residents.types';

export class FlagCreatedView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The open flag (an existing one when already open).',
  })
  flagId: string;
}

/** A member whose permissions predate the current primary; never contact data. */
export class MemberToReviewView {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ enum: HouseholdRelation, enumName: 'HouseholdRelation' })
  relation: HouseholdRelation;
  @ApiProperty({ type: Boolean })
  isMinor: boolean;

  static from(m: MemberToReview): MemberToReviewView {
    return {
      memberId: m.memberId,
      fullName: m.fullName,
      relation: m.relation,
      isMinor: m.isMinor,
    };
  }
}

export class ReviewedView {
  @ApiProperty({ type: Number })
  reviewed: number;
}
