import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { ObjectStorage } from './object-storage';

const settings: Partial<Env> = {
  S3_ENDPOINT: 'https://0123abcd.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_FORCE_PATH_STYLE: true,
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'jiwar-dev',
  S3_URL_TTL_SECONDS: 300,
};
const config = {
  get: (name: keyof Env) => settings[name],
} as unknown as ConfigService<Env, true>;

/** Presigning is local (no request), so R2's settings work offline. */
describe('ObjectStorage presigning (R2 settings)', () => {
  const storage = new ObjectStorage(config);
  afterAll(() => storage.onApplicationShutdown());

  it('signs the upload to its type, its size and "only once"', async () => {
    const before = Date.now();
    const up = await storage.presignPut('t/tenant/file', 'image/png', 1234);
    const url = new URL(up.url);

    expect(url.origin).toBe('https://0123abcd.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/jiwar-dev/t/tenant/file');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    );
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /\/auto\/s3\/aws4_request$/,
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(up.headers).toEqual({
      'Content-Type': 'image/png',
      'If-None-Match': '*',
    });
    expect(up.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
  });

  it('sets no ACL and no checksum (R2 has no ACLs; browsers send no CRC)', async () => {
    const up = await storage.presignPut('t/tenant/file', 'application/pdf', 9);
    const params = [...new URL(up.url).searchParams.keys()].map((k) =>
      k.toLowerCase(),
    );
    expect(params.filter((k) => /acl|checksum/.test(k))).toEqual([]);
    expect(up.url).not.toMatch(/x-amz-acl|x-amz-checksum/i);
  });

  it('signs reads for S3_URL_TTL_SECONDS', async () => {
    const read = await storage.presignGet('t/tenant/file');
    const url = new URL(read.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(read.url).not.toMatch(/checksum/i);
  });
});

/** R2 is configured through S3_* only (ADR 0029). */
describe('storage configuration', () => {
  const root = join(__dirname, '..', '..'); // src/

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('src/ reads no R2_* variable', () => {
    const offenders = sourceFiles(root)
      .filter((file) => /\bR2_[A-Z]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
