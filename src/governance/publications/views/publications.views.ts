import { ApiProperty } from '@nestjs/swagger';
import { PUBLICATION_KINDS } from '../dto/publications.dto';
import type { PublicationRecord } from '../publications.service';

/** A decision or the minutes of the board (ADR 0051). */
export class BoardPublicationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: PUBLICATION_KINDS, enumName: 'BoardPublicationKind' })
  kind: (typeof PUBLICATION_KINDS)[number];
  @ApiProperty({ type: String, example: '2026-11-01' })
  decidedOn: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The board that published it.',
  })
  termId: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'Its announcement (`GET /announcements/{id}`): where the owners read it, with its PDF.',
  })
  announcementId: string;
  @ApiProperty({ type: String, nullable: true })
  titleEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  titleAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyAr: string | null;
  @ApiProperty({ type: Boolean })
  hasAttachment: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  editedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt: Date | null;

  static from(r: PublicationRecord): BoardPublicationView {
    const p = r.publication;
    return {
      id: p.id,
      kind: p.kind as BoardPublicationView['kind'],
      decidedOn: p.decidedOn.toISOString().slice(0, 10),
      termId: p.termId,
      announcementId: p.announcementId,
      titleEn: r.text.titleEn ?? null,
      bodyEn: r.text.bodyEn ?? null,
      titleAr: r.text.titleAr ?? null,
      bodyAr: r.text.bodyAr ?? null,
      hasAttachment: r.text.attachments > 0,
      publishedAt: p.createdAt,
      editedAt: r.text.editedAt,
      archivedAt: p.archivedAt,
    };
  }
}
