import { ApiProperty } from '@nestjs/swagger';
import type { WarrantyClaim } from '@prisma/client';
import {
  WARRANTY_CLAIM_STATUSES,
  type WarrantyClaimStatus,
} from '../warranty-claims.service';

/** A claim under an asset's warranty (ADR 0076). */
export class WarrantyClaimView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  assetId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  ticketId: string | null;
  @ApiProperty({ type: String, description: 'What failed: staff’s words.' })
  description: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The warrantor’s own reference.',
  })
  reference: string | null;
  @ApiProperty({ enum: WARRANTY_CLAIM_STATUSES })
  status: WarrantyClaimStatus;
  @ApiProperty({ type: String, format: 'uuid' })
  openedById: string;
  @ApiProperty({ type: String, format: 'date-time' })
  openedAt: Date;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  decidedById: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A rejection’s or a withdrawal’s code.',
  })
  reasonCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the warrantor paid or covered, EGP; an acceptance only.',
  })
  recoveredAmount: string | null;

  static from(c: WarrantyClaim): WarrantyClaimView {
    return {
      id: c.id,
      assetId: c.assetId,
      ticketId: c.ticketId,
      description: c.description,
      reference: c.reference,
      status: c.status as WarrantyClaimStatus,
      openedById: c.openedById,
      openedAt: c.openedAt,
      decidedById: c.decidedById,
      decidedAt: c.decidedAt,
      reasonCode: c.reasonCode,
      recoveredAmount: c.recoveredAmount?.toFixed(2) ?? null,
    };
  }
}
