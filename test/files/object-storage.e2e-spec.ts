import { ConfigService } from '@nestjs/config';
import { newId } from '../../src/core/common/uuid';
import { validateEnv, type Env } from '../../src/core/config/env.schema';
import { ObjectStorage } from '../../src/core/files/object-storage';

const PDF = Buffer.from('%PDF-1.7\nnot really a document\n');

/** ObjectStorage against the local MinIO's test bucket (test-env.ts). */
describe('ObjectStorage (MinIO)', () => {
  let storage: ObjectStorage;
  const key = () => `t/${newId()}/${newId()}`;
  const put = (
    url: string,
    body: Buffer,
    headers: Record<string, string> = {},
  ) =>
    fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: {
        'Content-Type': 'application/pdf',
        'If-None-Match': '*',
        ...headers,
      },
    });

  beforeAll(() => {
    storage = new ObjectStorage(
      new ConfigService<Env, true>(validateEnv(process.env)),
    );
  });
  afterAll(() => storage.onApplicationShutdown());

  it('takes exactly the signed size and type, once, and reads it back', async () => {
    const k = key();
    const up = await storage.presignPut(k, 'application/pdf', PDF.length);

    // A different size or type fails the signature: the store refuses it.
    expect((await put(up.url, Buffer.concat([PDF, PDF]))).status).toBe(403);
    expect(
      (await put(up.url, PDF, { 'Content-Type': 'image/png' })).status,
    ).toBe(403);
    expect((await put(up.url, PDF, { 'If-None-Match': '' })).status).toBe(403);
    expect(await storage.head(k)).toBeNull();

    expect((await put(up.url, PDF)).status).toBe(200);
    // The same URL cannot replace the bytes afterwards (If-None-Match: *).
    const again = Buffer.from(PDF);
    again.write('XXXX', 10);
    expect((await put(up.url, again)).status).toBe(412);

    expect(await storage.head(k)).toEqual({
      size: PDF.length,
      contentType: 'application/pdf',
    });
    expect(await storage.firstBytes(k, 5)).toEqual(Buffer.from('%PDF-'));

    const read = await storage.presignGet(k);
    expect(new URL(read.url).searchParams.get('X-Amz-Expires')).toBe('300');
    const res = await fetch(read.url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF);
  });

  it('keeps the bucket private: no unsigned read or write', async () => {
    const k = key();
    const up = await storage.presignPut(k, 'application/pdf', PDF.length);
    await put(up.url, PDF);
    const signed = new URL((await storage.presignGet(k)).url);
    const bare = `${signed.origin}${signed.pathname}`;

    expect((await fetch(bare)).status).toBe(403);
    expect((await put(bare, PDF)).status).toBe(403);
  });

  it('deletes, and a missing object counts as deleted', async () => {
    const k = key();
    const up = await storage.presignPut(k, 'application/pdf', PDF.length);
    await put(up.url, PDF);

    expect(await storage.delete(k)).toBe(true);
    expect(await storage.head(k)).toBeNull();
    expect(await storage.delete(k)).toBe(true);
  });

  it('a stopped store is STORAGE_UNAVAILABLE, without its text', async () => {
    const down = new ObjectStorage(
      new ConfigService<Env, true>(
        validateEnv({ ...process.env, S3_ENDPOINT: 'http://127.0.0.1:9' }),
      ),
    );
    try {
      await expect(down.head(key())).rejects.toMatchObject({
        status: 503,
        response: {
          code: 'STORAGE_UNAVAILABLE',
          message: 'File storage is unavailable',
        },
      });
      await expect(down.firstBytes(key(), 4)).rejects.toMatchObject({
        status: 503,
      });
      expect(await down.delete(key())).toBe(false);
    } finally {
      down.onApplicationShutdown();
    }
  });
});
