import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { ofDateColumn, ofDateColumnOrNull } from '../../schedules/local-dates';
import {
  CERTIFICATE_STATES,
  STAFF_CERTIFICATE_KINDS,
} from '../certificate-rules';
import type { CertificateRead } from '../certificates.service';

/** A staff member's certificate (ADR 0090). */
export class StaffCertificateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView, description: 'Its holder.' })
  holder: AccountRefView;
  @ApiProperty({
    enum: STAFF_CERTIFICATE_KINDS,
    enumName: 'StaffCertificateKind',
  })
  kind: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, nullable: true })
  issuer: string | null;
  @ApiProperty({ type: String, nullable: true })
  reference: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  issuedOn: string | null;
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Its last day in force.',
  })
  expiresOn: string;
  @ApiProperty({
    enum: CERTIFICATE_STATES,
    enumName: 'StaffCertificateState',
    description:
      'On the compound’s today: `expiring` within 30 days, `expired` from the day after its expiry. It blocks nothing.',
  })
  state: string;
  @ApiProperty({
    type: Number,
    description: 'Days from today to its expiry; negative once expired.',
  })
  daysLeft: number;
  @ApiProperty({ type: Boolean, description: 'Whether a paper is filed.' })
  hasFile: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A short-lived link to the paper, on a single certificate only; null in lists and when none is filed.',
  })
  fileUrl: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  removedAt: string | null;

  static from(r: CertificateRead): StaffCertificateView {
    const c = r.certificate;
    return {
      id: c.id,
      holder: accountRef(r.holder),
      kind: c.kind,
      title: c.title,
      issuer: c.issuer,
      reference: c.reference,
      issuedOn: ofDateColumnOrNull(c.issuedOn),
      expiresOn: ofDateColumn(c.expiresOn),
      state: r.state,
      daysLeft: r.daysLeft,
      hasFile: c.fileId !== null,
      fileUrl: r.read?.url ?? null,
      addedAt: c.addedAt.toISOString(),
      removedAt: c.removedAt?.toISOString() ?? null,
    };
  }
}
