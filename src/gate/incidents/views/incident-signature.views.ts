import { ApiProperty } from '@nestjs/swagger';
import { FirstNameRefView } from '../../../core/common/http/personal';
import { PresignedReadView } from '../../../core/files/views/file.views';
import {
  SIGNATURE_ROLES,
  type SignatureRole,
} from '../incident-signature-content';
import type { SignatureRecord } from '../incident-signatures.service';

/** A drawn signature on an incident report (ADR 0056). */
export class IncidentSignatureView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: SIGNATURE_ROLES, enumName: 'IncidentSignatureRole' })
  role: SignatureRole;
  @ApiProperty({ type: FirstNameRefView })
  signer: FirstNameRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  signedAt: Date;
  @ApiProperty({
    type: String,
    description:
      'The SHA-256, in hex, of the report’s canonical content for its role when signed.',
  })
  contentSha256: string;
  @ApiProperty({ type: Number, description: 'Which canonical form: 1.' })
  canonicalVersion: number;
  @ApiProperty({
    type: Boolean,
    description:
      'The content of its role changed since: a new signature is needed. Closing the incident supersedes a reviewer’s, never the author’s.',
  })
  superseded: boolean;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description: 'The drawn signature; null once its signer was erased.',
  })
  image: PresignedReadView | null;
  @ApiProperty({ type: Boolean })
  imageCleared: boolean;

  static from(s: SignatureRecord): IncidentSignatureView {
    return {
      id: s.id,
      role: s.role,
      signer: { ...s.signer },
      signedAt: s.signedAt,
      contentSha256: s.contentSha256,
      canonicalVersion: s.canonicalVersion,
      superseded: s.superseded,
      image: PresignedReadView.from(s.image),
      imageCleared: s.imageCleared,
    };
  }
}
