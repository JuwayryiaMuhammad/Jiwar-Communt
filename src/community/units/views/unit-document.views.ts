import { ApiProperty } from '@nestjs/swagger';
import type { PresignedRead } from '../../../core/files/object-storage';
import {
  UNIT_DOCUMENT_KINDS,
  UNIT_DOCUMENT_VISIBILITIES,
  type UnitDocumentRead,
} from '../unit-documents.service';

/** A document in a unit's vault (ADR 0062); its file is read with its own route. */
export class UnitDocumentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ enum: UNIT_DOCUMENT_KINDS })
  kind: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ enum: UNIT_DOCUMENT_VISIBILITIES })
  visibility: string;
  @ApiProperty({
    enum: ['unit', 'occupancy'],
    description: '`unit`: the management’s; `occupancy`: a resident’s.',
  })
  holder: 'unit' | 'occupancy';
  @ApiProperty({
    type: Boolean,
    description: 'Whether the caller may delete it.',
  })
  mine: boolean;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  expiresOn: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(d: UnitDocumentRead): UnitDocumentView {
    return {
      id: d.id,
      unitId: d.unitId,
      kind: d.kind,
      title: d.title,
      visibility: d.visibility,
      holder: d.holder,
      mine: d.mine,
      expiresOn: d.expiresOn ? d.expiresOn.toISOString().slice(0, 10) : null,
      createdAt: d.createdAt,
    };
  }
}

/** A document to look at (no-store): the presigned GET. */
export class UnitDocumentReadView extends UnitDocumentView {
  @ApiProperty({ type: String, description: 'A presigned GET.' })
  url: string;
  @ApiProperty({ type: String, format: 'date-time' })
  urlExpiresAt: Date;

  static fromRead(d: {
    document: UnitDocumentRead;
    read: PresignedRead;
  }): UnitDocumentReadView {
    return {
      ...UnitDocumentView.from(d.document),
      url: d.read.url,
      urlExpiresAt: d.read.expiresAt,
    };
  }
}
