import { ApiProperty } from '@nestjs/swagger';
import { OccupancyType } from '@prisma/client';
import type { PresignedUpload } from '../../../core/files/object-storage';
import { IMAGE_TYPES } from '../../../core/files/purposes';
import { UploadTargetView } from '../../../core/files/views/file.views';
import type {
  RegistrationDocumentKind,
  RegistrationDocumentRead,
  RegistrationStatusRead,
} from '../registration-documents.service';

/** The one answer to every registrant at start (ADR 0024). */
export class RegistrationCodeSentView {
  @ApiProperty({ enum: ['REGISTRATION_CODE_SENT'] })
  code: 'REGISTRATION_CODE_SENT';
}

/** The one answer at completion, whatever the link or the unit. */
export class RegistrationReceivedView {
  @ApiProperty({ enum: ['REGISTRATION_RECEIVED'] })
  code: 'REGISTRATION_RECEIVED';
}

const KINDS = ['ownership_proof', 'lease_proof', 'other_proof'] as const;
const CORRECTIONS = [
  'document_unreadable',
  'document_missing',
  'document_mismatch',
  'details_mismatch',
] as const;

/** One of a request's documents: its kind and state, never a file name. */
export class RegistrationDocumentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: KINDS })
  kind: RegistrationDocumentKind;
  @ApiProperty({ type: String, enum: [...IMAGE_TYPES, 'application/pdf'] })
  contentType: string;
  @ApiProperty({
    type: Boolean,
    description: 'Finalized: the upload arrived and was checked.',
  })
  ready: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(d: RegistrationDocumentRead): RegistrationDocumentView {
    return {
      id: d.id,
      kind: d.kind,
      contentType: d.contentType,
      ready: d.ready,
      createdAt: d.createdAt,
    };
  }
}

/**
 * A request as its status link shows it (ADR 0062): its state, what the
 * management asked to correct, and its documents. No name, phone, email or
 * ID: the link proves only that its holder got the email.
 */
export class RegistrationStatusView {
  @ApiProperty({ type: String })
  compoundName: string;
  @ApiProperty({
    enum: ['pending', 'needs_correction'],
    description:
      'A decided or expired request is not found: the decision email says how it ended.',
  })
  status: 'pending' | 'needs_correction';
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: OccupancyType, enumName: 'OccupancyType' })
  occupancyType: OccupancyType;
  @ApiProperty({
    enum: CORRECTIONS,
    isArray: true,
    description: 'What to correct; empty unless `needs_correction`.',
  })
  correctionCodes: string[];
  @ApiProperty({ type: [RegistrationDocumentView] })
  documents: RegistrationDocumentView[];
  @ApiProperty({
    type: Number,
    description: 'Documents a request holds at most, uploads included.',
  })
  maxDocuments: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: RegistrationStatusRead): RegistrationStatusView {
    return {
      compoundName: r.compoundName,
      status: r.status,
      unitCode: r.unitCode,
      occupancyType: r.occupancyType,
      correctionCodes: [...r.correctionCodes],
      documents: r.documents.map((d) => RegistrationDocumentView.from(d)),
      maxDocuments: r.maxDocuments,
      createdAt: r.createdAt,
    };
  }
}

/** A document's upload: PUT the bytes to `upload`, then finalize the document. */
export class RegistrationUploadView {
  @ApiProperty({ type: RegistrationDocumentView })
  document: RegistrationDocumentView;
  @ApiProperty({ type: UploadTargetView })
  upload: UploadTargetView;

  static from(u: {
    document: RegistrationDocumentRead;
    upload: PresignedUpload;
  }): RegistrationUploadView {
    return {
      document: RegistrationDocumentView.from(u.document),
      upload: UploadTargetView.from(u.upload),
    };
  }
}
