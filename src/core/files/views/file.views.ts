import { ApiProperty } from '@nestjs/swagger';
import { FilePurpose, FileStatus, type StoredFile } from '@prisma/client';
import type { PresignedRead, PresignedUpload } from '../object-storage';

export class FileView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: FilePurpose, enumName: 'FilePurpose' })
  purpose: FilePurpose;
  @ApiProperty({ type: String })
  contentType: string;
  @ApiProperty({ type: Number })
  size: number;
  @ApiProperty({
    enum: FileStatus,
    enumName: 'FileStatus',
    description: '`pending` until finalized.',
  })
  status: FileStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(f: StoredFile): FileView {
    return {
      id: f.id,
      purpose: f.purpose,
      contentType: f.contentType,
      size: f.sizeBytes,
      status: f.status,
      createdAt: f.createdAt,
    };
  }
}

export class UploadHeadersView {
  @ApiProperty({ type: String, name: 'Content-Type' })
  'Content-Type': string;
  @ApiProperty({ type: String, name: 'If-None-Match', enum: ['*'] })
  'If-None-Match': '*';
}

export class UploadTargetView {
  @ApiProperty({ type: String, description: 'Presigned; shown once.' })
  url: string;
  @ApiProperty({ type: String, enum: ['PUT'] })
  method: 'PUT';
  @ApiProperty({
    type: UploadHeadersView,
    description:
      'Send exactly these. Content-Length is the body, which must be the declared size.',
  })
  headers: UploadHeadersView;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(u: PresignedUpload): UploadTargetView {
    return {
      url: u.url,
      method: 'PUT',
      headers: { ...u.headers },
      expiresAt: u.expiresAt,
    };
  }
}

/** A new upload: PUT the bytes to `upload`, then finalize. */
export class NewUploadView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: UploadTargetView })
  upload: UploadTargetView;
}

export class FileReadView extends FileView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned GET, once finalized; valid until `urlExpiresAt`.',
  })
  url: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  urlExpiresAt: Date | null;

  static fromRead(f: StoredFile, read: PresignedRead | null): FileReadView {
    return {
      ...FileView.from(f),
      url: read?.url ?? null,
      urlExpiresAt: read?.expiresAt ?? null,
    };
  }
}
