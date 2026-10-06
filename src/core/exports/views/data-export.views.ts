import { ApiProperty } from '@nestjs/swagger';
import type { PresignedRead } from '../../files/object-storage';
import type { DataExportRead } from '../data-exports.service';

/** A request, never its content (ADR 0036). */
export class DataExportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: ['pending', 'building', 'ready', 'expired', 'failed'],
    enumName: 'DataExportStatus',
  })
  status: DataExportRead['status'];
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readyAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Downloadable until then; then the file is deleted.',
  })
  expiresAt: Date | null;
  @ApiProperty({
    type: Boolean,
    description: 'Filed by the management for the account; sent to its email.',
  })
  assisted: boolean;

  static from(r: DataExportRead): DataExportView {
    return {
      id: r.id,
      status: r.status,
      requestedAt: r.requestedAt,
      readyAt: r.readyAt,
      expiresAt: r.expiresAt,
      assisted: r.assisted,
    };
  }
}

export class DownloadView {
  @ApiProperty({
    type: String,
    description: 'A presigned GET of the archive, valid a few minutes.',
  })
  url: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(r: PresignedRead): DownloadView {
    return { url: r.url, expiresAt: r.expiresAt };
  }
}
