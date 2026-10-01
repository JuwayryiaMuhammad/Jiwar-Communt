import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '../common/cls/request-context';
import { FieldErrorCode } from '../common/errors';
import { ObjectStorage } from './object-storage';
import type { UploadFolder } from './upload-folder.enum';
import {
  invalidFile,
  validateUpload,
  type SignatureKind,
} from './upload-validator';

const FIVE_MB = 5 * 1024 * 1024;
const TWENTY_MB = 20 * 1024 * 1024;

/**
 * What each kind of upload accepts. An image lands in a column rendered
 * straight into an `<img>` (a photo), so a PDF there is never what the caller
 * meant; a document (PDF and both Office generations) is downloaded and
 * opened elsewhere, never rendered by us.
 */
const ACCEPT = {
  image: { kinds: ['png', 'jpeg', 'webp', 'gif'], maxBytes: FIVE_MB },
  document: {
    kinds: ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'],
    maxBytes: TWENTY_MB,
  },
} satisfies Record<string, { kinds: SignatureKind[]; maxBytes: number }>;

/** The slice of `Express.Multer.File` an upload reads. */
export interface UploadCandidate {
  /** The multipart field, reported in validation errors. */
  fieldname?: string;
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

export interface StoredFile {
  /** `{tenantId}/{folder}/{uuid}.{ext}` — what the row keeps, never a URL. */
  key: string;
  /** The uploader's file name. */
  name: string;
  size: number;
  /** The detected type, not the declared one. */
  mimeType: string;
}

/**
 * Uploads for feature services (ADR 0029). There is no upload endpoint: the
 * action that owns the file takes it, with that action's permission and
 * audit entry.
 *
 * An upload cannot join a database transaction, so the order is fixed here:
 * validate, put the object, then run `write` (the action's transaction) with
 * the stored file. A `write` that throws deletes the object, so a rolled-back
 * action leaves no file behind. Only a crash between the put and the commit
 * can orphan one.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly ctx: RequestContext,
  ) {}

  storeImage<T>(
    folder: UploadFolder,
    file: UploadCandidate | undefined,
    write: (stored: StoredFile) => Promise<T>,
  ): Promise<T> {
    return this.store(folder, file, 'image', write);
  }

  storeDocument<T>(
    folder: UploadFolder,
    file: UploadCandidate | undefined,
    write: (stored: StoredFile) => Promise<T>,
  ): Promise<T> {
    return this.store(folder, file, 'document', write);
  }

  /**
   * A read URL for a stored key, valid for S3_URL_TTL_SECONDS. The key comes
   * off a row the caller has already authorized; one of another compound is
   * a programming error, never served.
   */
  url(key: string): Promise<string> {
    if (!key.startsWith(`${this.ctx.tenantId}/`)) {
      throw new Error("Refusing a presigned URL for another tenant's object");
    }
    return this.storage.signedUrl(key);
  }

  /**
   * Drops an object the row no longer points at (a replaced photo, an erased
   * account). Call it after the transaction that cleared the key commits:
   * deleting first loses the file if that transaction rolls back.
   * Best-effort, like every cleanup path.
   */
  async deleteObject(key: string | null | undefined): Promise<void> {
    if (key) await this.storage.delete(key);
  }

  private async store<T>(
    folder: UploadFolder,
    file: UploadCandidate | undefined,
    accept: keyof typeof ACCEPT,
    write: (stored: StoredFile) => Promise<T>,
  ): Promise<T> {
    const field = file?.fieldname ?? 'file';
    if (!file) {
      throw invalidFile(
        field,
        FieldErrorCode.FIELD_REQUIRED,
        'No file uploaded',
      );
    }
    const { kinds, maxBytes } = ACCEPT[accept];
    if (file.buffer.length > maxBytes) {
      throw invalidFile(
        field,
        FieldErrorCode.FILE_TOO_LARGE,
        `File exceeds ${maxBytes} bytes`,
        { maxBytes },
      );
    }
    const detected = validateUpload(file.buffer, file.mimetype, kinds, field);

    const stored: StoredFile = {
      key: `${this.ctx.tenantId}/${folder}/${randomUUID()}.${detected.ext}`,
      name: file.originalname,
      size: file.buffer.length,
      mimeType: detected.mime,
    };
    await this.storage.put(stored.key, file.buffer, detected.mime);
    try {
      return await write(stored);
    } catch (error) {
      await this.storage.delete(stored.key);
      throw error;
    }
  }
}
