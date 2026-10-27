import { ApiProperty } from '@nestjs/swagger';
import type { PresignedRead } from '../../../core/files/object-storage';
import {
  COMPOUND_DOCUMENT_KINDS,
  type CompoundDocumentRead,
  type CompoundDocumentSummary,
} from '../compound-documents.service';

/** A version of a compound document, without its body (ADR 0062). */
export class CompoundDocumentSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: COMPOUND_DOCUMENT_KINDS })
  kind: string;
  @ApiProperty({ type: Number })
  versionNo: number;
  @ApiProperty({ type: String })
  titleEn: string;
  @ApiProperty({ type: String })
  titleAr: string;
  @ApiProperty({ type: String, format: 'date' })
  effectiveOn: string;
  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt: Date;
  @ApiProperty({ type: Boolean, description: 'Whether it has a signed PDF.' })
  hasFile: boolean;

  static from(d: CompoundDocumentSummary): CompoundDocumentSummaryView {
    return {
      id: d.id,
      kind: d.kind,
      versionNo: d.versionNo,
      titleEn: d.titleEn,
      titleAr: d.titleAr,
      effectiveOn: d.effectiveOn.toISOString().slice(0, 10),
      publishedAt: d.publishedAt,
      hasFile: d.hasFile,
    };
  }
}

/** A version in full; its PDF's URL when it has one (no-store). */
export class CompoundDocumentView extends CompoundDocumentSummaryView {
  @ApiProperty({ type: String, description: 'Markdown.' })
  bodyEn: string;
  @ApiProperty({ type: String, description: 'Markdown.' })
  bodyAr: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What it changes; null on the first version.',
  })
  changesEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  changesAr: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The bylaws: the board decision that adopted it.',
  })
  boardPublicationId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned GET of the signed PDF.',
  })
  fileUrl: string | null;

  static fromRead(
    d: CompoundDocumentRead,
    read: PresignedRead | null,
  ): CompoundDocumentView {
    return {
      ...CompoundDocumentSummaryView.from(d),
      bodyEn: d.bodyEn,
      bodyAr: d.bodyAr,
      changesEn: d.changesEn,
      changesAr: d.changesAr,
      boardPublicationId: d.boardPublicationId,
      fileUrl: read?.url ?? null,
    };
  }
}
