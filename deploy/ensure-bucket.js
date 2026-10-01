// Staging only: creates S3_BUCKET on the stack's MinIO if it is missing. Run
// by the deploy script before the app starts. `pnpm storage:init` refuses
// NODE_ENV=production on purpose, and a real bucket is provisioned with its
// own encryption and lifecycle rules, not by this script.
'use strict';

let s3;
try {
  s3 = require('@aws-sdk/client-s3');
} catch {
  console.log('ensure-bucket: this release has no object storage, skipped.');
  process.exit(0);
}

const env = process.env;
const client = new s3.S3Client({
  // The internal address: the public one goes through nginx.
  endpoint: 'http://minio:9000',
  region: env.S3_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

async function main() {
  const Bucket = env.S3_BUCKET;
  try {
    await client.send(new s3.HeadBucketCommand({ Bucket }));
    console.log(`ensure-bucket: ${Bucket} exists.`);
    return;
  } catch (error) {
    if (error.name !== 'NotFound') throw error;
  }
  await client.send(new s3.CreateBucketCommand({ Bucket }));
  console.log(`ensure-bucket: ${Bucket} created.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.destroy());
