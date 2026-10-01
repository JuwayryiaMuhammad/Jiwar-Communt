import 'dotenv/config';
import { validateEnv } from '../config/env.schema';
import { ensureBucket, s3Client } from './object-storage';

/**
 * `pnpm storage:init`: creates S3_BUCKET on the local MinIO once, after
 * `docker compose up` (ADR 0029). Refused in production, where the bucket is
 * provisioned with its own encryption and lifecycle rules.
 */
async function main(): Promise<void> {
  const env = validateEnv(process.env);
  if (env.NODE_ENV === 'production') {
    throw new Error('storage:init is for development; provision the bucket');
  }
  const client = s3Client(env);
  try {
    const result = await ensureBucket(client, env.S3_BUCKET);
    console.log(`storage:init: bucket ${env.S3_BUCKET} ${result}.`);
  } finally {
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
