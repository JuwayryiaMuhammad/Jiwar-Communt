import { ApiProperty } from '@nestjs/swagger';
import type {
  InspectionRead,
  PublicWorksCertificate,
} from '../permit-inspections.service';

/** A works permit's completion inspection (ADR 0063). */
export class PermitInspectionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  permitId: string;
  @ApiProperty({ type: Number, description: 'The first, then each re-ask.' })
  cycle: number;
  @ApiProperty({ enum: ['asked', 'passed', 'failed'] })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: [String],
    description: 'A failure’s findings (REASON_CODES.worksFinding).',
  })
  findings: string[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A pass’s certificate: `WC-` and the number.',
  })
  certificateNumber: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The certificate’s code: anyone checks it at `<PUBLIC_APP_URL>/w#<code>`.',
  })
  verifyCode: string | null;

  static from(i: InspectionRead): PermitInspectionView {
    return { ...i };
  }
}

export class StaffPermitInspectionView extends PermitInspectionView {
  @ApiProperty({ type: String })
  permitReference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;

  static fromStaff(
    i: InspectionRead & {
      permitReference: string;
      unitId: string;
      unitCode: string;
    },
  ): StaffPermitInspectionView {
    return { ...i };
  }
}

/** A works certificate, publicly: no person. */
export class PublicWorksCertificateView {
  @ApiProperty({ type: String })
  compoundName: string;
  @ApiProperty({ type: String, example: 'WC-000012' })
  number: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  passedAt: Date;

  static from(c: PublicWorksCertificate): PublicWorksCertificateView {
    return { ...c };
  }
}
