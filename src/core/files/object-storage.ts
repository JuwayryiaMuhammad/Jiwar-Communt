import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

/**
 * The one S3 client (S3_* settings; ADR 0029). The bucket is private: nothing
 * in it has a public URL, and reads go through presigned URLs that expire
 * after S3_URL_TTL_SECONDS. Only FilesService uses this.
 */
@Injectable()
export class ObjectStorage implements OnApplicationShutdown {
  private readonly logger = new Logger(ObjectStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly urlTtlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.client = s3Client({
      S3_ENDPOINT: config.get('S3_ENDPOINT', { infer: true }),
      S3_REGION: config.get('S3_REGION', { infer: true }),
      S3_FORCE_PATH_STYLE: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      S3_ACCESS_KEY_ID: config.get('S3_ACCESS_KEY_ID', { infer: true }),
      S3_SECRET_ACCESS_KEY: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
    });
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.urlTtlSeconds = config.get('S3_URL_TTL_SECONDS', { infer: true });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Best-effort: an object left behind never fails the request that outlived
   * it. Logged with the key only (keys carry no personal data).
   */
  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Object delete failed, ${key} is orphaned: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A read URL for one object, valid for S3_URL_TTL_SECONDS. */
  signedUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.urlTtlSeconds },
    );
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

type S3Settings = Pick<
  Env,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
>;

/** The client for the S3_* settings; also used by storage:init and tests. */
export function s3Client(env: S3Settings): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Creates the bucket if it is missing (private: S3's default). For local
 * development and tests only; a production bucket is provisioned with its
 * encryption and lifecycle rules, not by the app.
 */
export async function ensureBucket(
  client: S3Client,
  bucket: string,
): Promise<'created' | 'exists'> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return 'exists';
  } catch (error: unknown) {
    if ((error as { name?: string }).name !== 'NotFound') throw error;
  }
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return 'created';
}
