import { ApiProperty } from '@nestjs/swagger';
import { DOCUMENT_KINDS, type DocumentKind } from '../asset-rules';
import type { DocumentRead } from '../documents.service';

/** A plan, a manual, a warranty card (ADR 0064), with a read URL. */
export class MaintenanceDocumentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetTypeId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  commonAreaId: string | null;
  @ApiProperty({ enum: DOCUMENT_KINDS })
  kind: DocumentKind;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned; null when the file is gone.',
  })
  url: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  urlExpiresAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: Date;

  static from({ document: d, read }: DocumentRead): MaintenanceDocumentView {
    return {
      id: d.id,
      assetId: d.assetId,
      assetTypeId: d.assetTypeId,
      commonAreaId: d.commonAreaId,
      kind: d.kind as DocumentKind,
      title: d.title,
      url: read?.url ?? null,
      urlExpiresAt: read?.expiresAt ?? null,
      addedAt: d.addedAt,
    };
  }
}
