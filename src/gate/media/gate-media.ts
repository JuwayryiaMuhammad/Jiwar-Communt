import { Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import type { FilePurpose } from '@prisma/client';
import { FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { GateSettingsService } from '../settings/gate-settings.service';

const MB = 1024 * 1024;

export type MediaKind = 'audio' | 'video';

/** A record's two recording purposes: its sound's and its video's. */
export interface MediaPurposes {
  audio: FilePurpose;
  video: FilePurpose;
}

export const PATROL_NOTE_MEDIA: MediaPurposes = {
  audio: 'patrol_note_audio',
  video: 'patrol_note_video',
};
export const INCIDENT_MEDIA: MediaPurposes = {
  audio: 'incident_audio',
  video: 'incident_video',
};

/** A recording claimed for a record, and attached to it. */
export interface ClaimedMedia {
  fileId: string;
  kind: MediaKind;
  durationMs: number;
}

/** A record's recording as its readers see it. */
export class MediaView {
  @ApiProperty({ enum: ['audio', 'video'], enumName: 'MediaKind' })
  kind: MediaKind;
  @ApiProperty({ type: Number, description: 'Its length, in milliseconds.' })
  durationMs: number;
  @ApiProperty({ type: String, description: 'A short-lived presigned URL.' })
  url: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static of(
    m: { kind: string; durationMs: number },
    read: PresignedRead,
  ): MediaView {
    return {
      kind: m.kind as MediaKind,
      durationMs: m.durationMs,
      url: read.url,
      expiresAt: read.expiresAt,
    };
  }
}

/**
 * Recordings on the gate's records (ADR 0056): a patrol note's or an
 * incident's sound or video, the caller's own finalized uploads of the
 * record's purposes. The gate's settings bound them when attached — the
 * megabytes (FILE_TOO_LARGE, params.maxBytes) and the seconds
 * (MEDIA_TOO_LONG, params.maxSeconds) — under the system's caps that the
 * upload and the database hold. The settings row is read FOR SHARE: a
 * change waits for the record, or applies to it whole.
 */
@Injectable()
export class GateMedia {
  constructor(
    private readonly files: FilesService,
    private readonly settings: GateSettingsService,
  ) {}

  /** Claims and attaches each recording, in the record's transaction. */
  async claim(
    tx: TenantTxClient,
    ids: readonly string[],
    purposes: MediaPurposes,
    field: string,
  ): Promise<ClaimedMedia[]> {
    if (!ids.length) return [];
    const limits = await this.settings.read(tx, 'share');
    const out: ClaimedMedia[] = [];
    for (const id of ids) {
      const file =
        (await this.files.claim(tx, id, purposes.audio)) ??
        (await this.files.claim(tx, id, purposes.video));
      if (!file || file.mediaDurationMs === null)
        throw invalid([{ field, code: FieldErrorCode.FILE_NOT_AVAILABLE }]);
      const kind: MediaKind =
        file.purpose === purposes.audio ? 'audio' : 'video';
      const maxBytes =
        (kind === 'audio' ? limits.audioMaxMb : limits.videoMaxMb) * MB;
      if (file.sizeBytes > maxBytes)
        throw invalid([
          { field, code: FieldErrorCode.FILE_TOO_LARGE, params: { maxBytes } },
        ]);
      const maxSeconds =
        kind === 'audio' ? limits.audioMaxSeconds : limits.videoMaxSeconds;
      if (file.mediaDurationMs > maxSeconds * 1000)
        throw invalid([
          {
            field,
            code: FieldErrorCode.MEDIA_TOO_LONG,
            params: { maxSeconds },
          },
        ]);
      await this.files.attach(tx, file);
      out.push({ fileId: file.id, kind, durationMs: file.mediaDurationMs });
    }
    return out;
  }

  /** Read URLs for a record's recordings, in order; the gone ones left out. */
  async views(
    tx: TenantTxClient,
    rows: readonly { fileId: string; kind: string; durationMs: number }[],
  ): Promise<MediaView[]> {
    const out: MediaView[] = [];
    for (const m of rows) {
      const read = await this.files.readUrl(tx, m.fileId);
      if (read) out.push(MediaView.of(m, read));
    }
    return out;
  }
}
