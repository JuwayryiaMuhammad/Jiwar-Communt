import { ApiProperty } from '@nestjs/swagger';
import { FirstNameRefView } from '../../../core/common/http/personal';
import { PresignedReadView } from '../../../core/files/views/file.views';
import type { EvidenceRecord } from '../incident-evidence.service';

/** What an incident keeps beyond its own photos (ADR 0056). */
export class IncidentEvidenceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ['visitor_photo'], enumName: 'IncidentEvidenceKind' })
  kind: 'visitor_photo';
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  entryId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  linkedAt: Date;
  @ApiProperty({ type: FirstNameRefView })
  linkedBy: FirstNameRefView;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description: 'The visitor’s photo, a short-lived presigned URL.',
  })
  photo: PresignedReadView | null;

  static from(e: EvidenceRecord): IncidentEvidenceView {
    return {
      id: e.id,
      kind: e.kind,
      entryId: e.entryId,
      linkedAt: e.linkedAt,
      linkedBy: { ...e.linkedBy },
      photo: PresignedReadView.from(e.photo),
    };
  }
}
