import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appError, ErrorCode } from '../common/errors';
import type { Env } from '../config/env.schema';

/**
 * Headers the uploader must send exactly as signed. A different size or
 * type fails the signature, and `If-None-Match: *` refuses a second PUT to
 * the same key, so bytes checked at finalize can never be swapped after.
 */
const SIGNED_UPLOAD_HEADERS = new Set([
  'content-type',
  'content-length',
  'if-none-match',
]);

/** The object key: tenant and file id only, never anything a client sent. */
export const objectKey = (f: { tenantId: string; id: string }): string =>
  `t/${f.tenantId}/${f.id}`;

export interface PresignedUpload {
  url: string;
  /** Send these with the PUT, unchanged (Content-Length is the body's). */
  headers: { 'Content-Type': string; 'If-None-Match': '*' };
  expiresAt: Date;
}

export interface PresignedRead {
  url: string;
  expiresAt: Date;
}

export interface ObjectHead {
  size: number;
  contentType: string | null;
}

/**
 * The one S3 client (S3_* settings; ADR 0029): Cloudflare R2 in
 * production, MinIO in development, CI and tests. The bucket is private:
 * nothing in it has a public URL, uploads and reads go through presigned
 * URLs valid for S3_URL_TTL_SECONDS. Objects never get an ACL (R2 has
 * none). Keys come from FilesService, never from a client.
 *
 * A failing or unreachable store is STORAGE_UNAVAILABLE (503), logged by
 * error name only: the store's own message never reaches a response.
 */
@Injectable()
export class ObjectStorage implements OnApplicationShutdown {
  private readonly logger = new Logger(ObjectStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.client = s3Client({
      S3_ENDPOINT: config.get('S3_ENDPOINT', { infer: true }),
      S3_REGION: config.get('S3_REGION', { infer: true }),
      S3_FORCE_PATH_STYLE: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      S3_ACCESS_KEY_ID: config.get('S3_ACCESS_KEY_ID', { infer: true }),
      S3_SECRET_ACCESS_KEY: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
    });
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.ttlSeconds = config.get('S3_URL_TTL_SECONDS', { infer: true });
  }

  /** A PUT URL for exactly this type and size, once. */
  async presignPut(
    key: string,
    contentType: string,
    size: number,
  ): Promise<PresignedUpload> {
    const expiresAt = this.expiry();
    const url = await this.call('presign', () =>
      getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: size,
          IfNoneMatch: '*',
        }),
        { expiresIn: this.ttlSeconds, signableHeaders: SIGNED_UPLOAD_HEADERS },
      ),
    );
    return {
      url,
      headers: { 'Content-Type': contentType, 'If-None-Match': '*' },
      expiresAt,
    };
  }

  /** A read URL for one object, valid for S3_URL_TTL_SECONDS. */
  async presignGet(key: string): Promise<PresignedRead> {
    const expiresAt = this.expiry();
    const url = await this.call('presign', () =>
      getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: this.ttlSeconds },
      ),
    );
    return { url, expiresAt };
  }

  /** Size and type of a stored object; null when there is none. */
  async head(key: string): Promise<ObjectHead | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
      };
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw this.unavailable('head', error);
    }
  }

  /** The first `count` bytes of an object (a ranged GET). */
  async firstBytes(key: string, count: number): Promise<Buffer> {
    return this.call('read', async () => {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${count - 1}`,
        }),
      );
      const bytes = await res.Body!.transformToByteArray();
      return Buffer.from(bytes).subarray(0, count);
    });
  }

  /**
   * Deletes one object; a missing one counts as deleted. Never throws:
   * false means it is still there, and the caller keeps whatever points at
   * it so the sweep tries again. Logged with the key only (keys carry no
   * personal data).
   */
  async delete(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(`object delete failed for ${key} (${errorName(error)})`);
      return false;
    }
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  private expiry(): Date {
    return new Date(Date.now() + this.ttlSeconds * 1000);
  }

  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      throw this.unavailable(op, error);
    }
  }

  private unavailable(op: string, error: unknown) {
    this.logger.error(`object storage ${op} failed (${errorName(error)})`);
    return appError.serviceUnavailable(
      ErrorCode.STORAGE_UNAVAILABLE,
      'File storage is unavailable',
    );
  }
}

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : 'Error';

const isNotFound = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
};

export type S3Settings = Pick<
  Env,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
>;

/**
 * The client for the S3_* settings; also used by storage:init and tests.
 *
 * Checksums only when an operation requires one: newer SDKs add CRC
 * headers by default, which R2 rejects on some operations and which a
 * presigned PUT cannot carry anyway (the browser computes no checksum).
 * Short timeouts, so a stalled store fails a request instead of holding it.
 */
export function s3Client(env: S3Settings): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
  });
}

/**
 * Creates the bucket if it is missing (private: the S3 default; no ACL is
 * ever set). For local development and tests only; a production bucket is
 * provisioned outside the app (deploy/README.md).
 */
export async function ensureBucket(
  client: S3Client,
  bucket: string,
): Promise<'created' | 'exists'> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return 'exists';
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return 'created';
}
