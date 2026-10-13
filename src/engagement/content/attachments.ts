import { Injectable } from '@nestjs/common';
import type { StoredFile } from '@prisma/client';
import { FieldErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { invalid } from '../../core/common/localized';

/** An announcement, an event or a "we did" note shows this many files at most. */
export const MAX_ATTACHMENTS = 5;

/** A file as a view shows it: what it is and where to read it now. */
export interface AttachmentRead {
  id: string;
  contentType: string;
  read: { url: string; expiresAt: Date } | null;
}

/**
 * The staff's files on community content (ADR 0029, 0040): images and
 * PDFs of the purpose `community_attachment`.
 */
@Injectable()
export class CommunityAttachments {
  constructor(private readonly files: FilesService) {}

  /** At most MAX_ATTACHMENTS, each once, or INVALID_LENGTH on `field`. */
  ids(ids: readonly string[] | undefined, field: string): string[] {
    const unique = [...new Set(ids ?? [])];
    if (unique.length > MAX_ATTACHMENTS)
      throw invalid([
        {
          field,
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 0, max: MAX_ATTACHMENTS },
        },
      ]);
    return unique;
  }

  /**
   * Takes one of the caller's own finalized `community_attachment` files
   * for the content: it no longer has an owner, so its uploader's erasure
   * leaves it (as a ticket's photos, ADR 0029). Anything else is
   * FILE_NOT_AVAILABLE on `field`.
   */
  async take(
    tx: TenantTxClient,
    fileId: string,
    field: string,
  ): Promise<StoredFile> {
    const file = await this.files.claim(tx, fileId, 'community_attachment');
    if (!file)
      throw invalid([{ field, code: FieldErrorCode.FILE_NOT_AVAILABLE }]);
    await this.files.attach(tx, file);
    return file;
  }

  /** Where to read each file now, in the order given. */
  async read(
    tx: TenantTxClient,
    rows: readonly {
      id: string;
      fileId: string;
      file: { contentType: string };
    }[],
  ): Promise<AttachmentRead[]> {
    const out: AttachmentRead[] = [];
    for (const row of rows)
      out.push({
        id: row.id,
        contentType: row.file.contentType,
        read: await this.files.readUrl(tx, row.fileId),
      });
    return out;
  }
}
