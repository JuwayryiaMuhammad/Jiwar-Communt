import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { newId } from '../../src/core/common/uuid';
import { validateEnv, type Env } from '../../src/core/config/env.schema';
import { ObjectStorage } from '../../src/core/files/object-storage';

/**
 * The R2 smoke test (ADR 0029): the real bucket named by S3_* in .env, not
 * the test MinIO. Skipped unless R2_SMOKE=1; run it by hand against the
 * dev bucket:
 *
 *   R2_SMOKE=1 pnpm test:r2-smoke
 *
 * It writes one object under t/smoke/ and deletes it.
 */
config({ quiet: true });
const run = process.env.R2_SMOKE === '1' ? describe : describe.skip;

run('object storage smoke test (R2)', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('jiwar r2 smoke test'),
  ]);
  const key = `t/smoke/${newId()}`;
  let env: Env;
  let storage: ObjectStorage;

  const put = (url: string, body: Buffer, headers: Record<string, string>) =>
    fetch(url, { method: 'PUT', body: new Uint8Array(body), headers });

  beforeAll(() => {
    env = validateEnv(process.env);
    storage = new ObjectStorage(new ConfigService<Env, true>(env));
    console.log(
      `R2 smoke: ${env.S3_ENDPOINT ?? '(AWS)'} region=${env.S3_REGION} bucket=${env.S3_BUCKET} key=${key}`,
    );
  });

  afterAll(async () => {
    await storage.delete(key);
    storage.onApplicationShutdown();
  });

  it('presigned PUT with a signed length: a wrong size is refused, the right one stored once', async () => {
    const up = await storage.presignPut(key, 'image/png', PNG.length);
    expect(new URL(up.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    );

    const wrongSize = await put(up.url, Buffer.concat([PNG, PNG]), up.headers);
    expect(wrongSize.status).toBeGreaterThanOrEqual(400);
    expect(wrongSize.status).toBeLessThan(500);
    const wrongType = await put(up.url, PNG, {
      ...up.headers,
      'Content-Type': 'image/jpeg',
    });
    expect(wrongType.status).toBeGreaterThanOrEqual(400);
    expect(wrongType.status).toBeLessThan(500);
    expect(await storage.head(key)).toBeNull();

    const ok = await put(up.url, PNG, up.headers);
    expect(ok.status).toBe(200);
    // If-None-Match: * — the bytes finalize checks cannot be replaced.
    const again = await put(up.url, Buffer.alloc(PNG.length, 1), up.headers);
    expect(again.status).toBe(412);
  });

  it('HEAD and a ranged GET see exactly what was signed', async () => {
    expect(await storage.head(key)).toEqual({
      size: PNG.length,
      contentType: 'image/png',
    });
    expect(await storage.firstBytes(key, 8)).toEqual(PNG.subarray(0, 8));
  });

  it('presigned GET reads it; an unsigned GET does not', async () => {
    const read = await storage.presignGet(key);
    expect(new URL(read.url).searchParams.get('X-Amz-Expires')).toBe(
      String(env.S3_URL_TTL_SECONDS),
    );
    const res = await fetch(read.url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);

    const signed = new URL(read.url);
    const bare = await fetch(`${signed.origin}${signed.pathname}`);
    expect(bare.status).not.toBe(200);
  });

  it('delete removes it', async () => {
    expect(await storage.delete(key)).toBe(true);
    expect(await storage.head(key)).toBeNull();
  });
});
