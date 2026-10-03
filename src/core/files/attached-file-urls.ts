import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';
import { ObjectStorage, objectKey, type PresignedRead } from './object-storage';

/**
 * A read URL for a record's attached file (ADR 0029). Apart from
 * FilesService so that the accounts module, which FilesModule imports, can
 * show an account's own photo without importing it back.
 */
@Injectable()
export class AttachedFileUrls {
  constructor(private readonly storage: ObjectStorage) {}

  /**
   * Presigning is local: no store call. The caller has authorized the
   * reader; null when there is no file or it is gone.
   */
  async read(
    tx: TenantTxClient,
    id: string | null,
  ): Promise<PresignedRead | null> {
    if (!id) return null;
    const file = await tx.storedFile.findFirst({
      where: { id, deletedAt: null, attachedAt: { not: null } },
      select: { id: true, tenantId: true },
    });
    return file ? this.storage.presignGet(objectKey(file)) : null;
  }
}
