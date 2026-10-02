import { ObjectStorage } from '../../src/core/files/object-storage';
import {
  FINALIZE_GRACE_MS,
  objectKey,
  PENDING_LIMIT,
} from '../../src/core/files/files.service';
import { auditReaders } from '../setup/audit';
import { fileHelpers, SAMPLE, type Upload } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const MB = 1024 * 1024;

describe('API v0 — files (ADR 0029)', () => {
  let h: HttpHarness;
  let w: World;
  let f: ReturnType<typeof fileHelpers>;
  let storage: ObjectStorage;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    f = fileHelpers(h);
    storage = h.moduleRef.get(ObjectStorage, { strict: false });
  }, 120_000);

  afterAll(() => h.close());

  /** A resident of A with a token of their own (a clean pending count). */
  async function someone() {
    const unit = await w.helpers.unit(w.a);
    const r = await w.helpers.resident(w.a, [unit.id]);
    return { id: r.id, token: await w.tokenFor(w.a, r.id, 'resident') };
  }

  const key = (id: string) => objectKey({ tenantId: w.a.tenantId, id });
  const row = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.storedFile.findUnique({ where: { id } }),
    );
  const get = (token: string, id: string) =>
    call(w, 'GET', `/files/${id}`, { token });

  it('declare, PUT, finalize, read: the whole flow', async () => {
    const me = await someone();
    const png = SAMPLE['image/png'];
    const res = await call(w, 'POST', '/files/uploads', {
      token: me.token,
      body: {
        purpose: 'worker_photo',
        contentType: 'image/png',
        size: png.length,
      },
    }).expect(201);
    const u = res.body as Upload;
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(u).sort()).toEqual(['id', 'upload']);
    expect(u.upload).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
    });
    // The key is the tenant and the id: nothing the client sent.
    expect(new URL(u.upload.url).pathname).toMatch(
      new RegExp(`/${key(u.id)}$`),
    );

    const pending = await get(me.token, u.id).expect(200);
    expect(pending.body).toMatchObject({
      id: u.id,
      purpose: 'worker_photo',
      contentType: 'image/png',
      size: png.length,
      status: 'pending',
      url: null,
      urlExpiresAt: null,
    });

    expect((await f.put(u, png)).status).toBe(200);
    const done = await f.finalize(me.token, u.id).expect(200);
    expect(done.body).toMatchObject({ id: u.id, status: 'ready' });
    expect(done.body).not.toHaveProperty('url');
    // Finalizing again changes nothing.
    await f.finalize(me.token, u.id).expect(200);

    const read = await get(me.token, u.id).expect(200);
    expect(read.headers['cache-control']).toBe('no-store');
    const body = read.body as { url: string; urlExpiresAt: string };
    expect(new URL(body.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(new Date(body.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());
    const object = await fetch(body.url);
    expect(object.status).toBe(200);
    expect(Buffer.from(await object.arrayBuffer())).toEqual(png);
  });

  it('every allowed type finalizes; a PDF only as a document', async () => {
    const me = await someone();
    for (const type of ['image/jpeg', 'image/png', 'image/webp'])
      await f.ready(me.token, 'worker_photo', type);
    await f.ready(w.a.tokens.manager, 'document', 'application/pdf');
    await f.ready(w.a.tokens.manager, 'document', 'image/jpeg');
  });

  it("each purpose's types, limit and uploaders", async () => {
    const owner = w.a.tokens.owner;
    const declare = (token: string, body: object) =>
      call(w, 'POST', '/files/uploads', { token, body });

    expect(
      err(
        await declare(owner, {
          purpose: 'worker_photo',
          contentType: 'application/pdf',
          size: 10,
        }).expect(400),
      ).fields,
    ).toEqual([
      {
        field: 'contentType',
        code: 'FILE_TYPE_NOT_ALLOWED',
        params: { allowed: ['image/jpeg', 'image/png', 'image/webp'] },
      },
    ]);
    expect(
      err(
        await declare(owner, {
          purpose: 'worker_photo',
          contentType: 'image/gif',
          size: 10,
        }).expect(400),
      ).fields?.[0].code,
    ).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(
      err(
        await declare(owner, {
          purpose: 'worker_photo',
          contentType: 'image/png',
          size: 5 * MB + 1,
        }).expect(400),
      ).fields,
    ).toEqual([
      { field: 'size', code: 'FILE_TOO_LARGE', params: { maxBytes: 5 * MB } },
    ]);
    await declare(owner, {
      purpose: 'worker_photo',
      contentType: 'image/png',
      size: 5 * MB,
    }).expect(201);

    // A document is management's.
    for (const token of [owner, w.a.tokens.family])
      expect(
        err(
          await declare(token, {
            purpose: 'document',
            contentType: 'application/pdf',
            size: 10,
          }).expect(403),
        ).code,
      ).toBe('FORBIDDEN');
    expect(
      err(
        await declare(w.a.tokens.manager, {
          purpose: 'document',
          contentType: 'application/pdf',
          size: 10 * MB + 1,
        }).expect(400),
      ).fields,
    ).toEqual([
      { field: 'size', code: 'FILE_TOO_LARGE', params: { maxBytes: 10 * MB } },
    ]);
    // The manager may set a worker's photo, so may upload one.
    await declare(w.a.tokens.manager, {
      purpose: 'worker_photo',
      contentType: 'image/webp',
      size: 100,
    }).expect(201);
  });

  it('the store takes only the declared size and type, once', async () => {
    const me = await someone();
    const png = SAMPLE['image/png'];
    const u = await f.declare(
      me.token,
      'worker_photo',
      'image/png',
      png.length,
    );

    expect((await f.put(u, Buffer.concat([png, png]))).status).toBe(403);
    expect((await f.put(u, png.subarray(1))).status).toBe(403);
    expect((await f.put(u, png, { 'Content-Type': 'image/jpeg' })).status).toBe(
      403,
    );
    expect((await f.put(u, png)).status).toBe(200);
    // Nothing can be swapped in after the check.
    expect((await f.put(u, Buffer.alloc(png.length, 7))).status).toBe(412);
    await f.finalize(me.token, u.id).expect(200);
    expect((await f.put(u, Buffer.alloc(png.length, 7))).status).toBe(412);
  });

  it('finalize before the upload: FILE_UPLOAD_MISSING, and the file waits', async () => {
    const me = await someone();
    const png = SAMPLE['image/png'];
    const u = await f.declare(
      me.token,
      'worker_photo',
      'image/png',
      png.length,
    );
    expect(err(await f.finalize(me.token, u.id).expect(409)).code).toBe(
      'FILE_UPLOAD_MISSING',
    );
    await f.put(u, png);
    await f.finalize(me.token, u.id).expect(200);
  });

  it('bytes that are not the declared type: FILE_CONTENT_MISMATCH, and the file is gone', async () => {
    const me = await someone();
    // A PDF of the right size, declared and sent as a PNG.
    const fake = Buffer.alloc(SAMPLE['image/png'].length, 0x20);
    SAMPLE['application/pdf'].copy(fake);
    const id = await f.uploaded(me.token, 'worker_photo', 'image/png', fake);

    expect(err(await f.finalize(me.token, id).expect(422)).code).toBe(
      'FILE_CONTENT_MISMATCH',
    );
    expect(err(await get(me.token, id).expect(404)).code).toBe(
      'FILE_NOT_FOUND',
    );
    expect(await storage.head(key(id))).toBeNull();
    expect(await row(id)).toBeNull();
    const [deleted] = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'file.deleted',
      targetId: id,
    });
    expect(deleted.metadata).toEqual({
      purpose: 'worker_photo',
      reasonCode: 'content_mismatch',
    });
  });

  it('finalize long after the upload expired: FILE_UPLOAD_EXPIRED', async () => {
    const me = await someone();
    const id = await f.uploaded(me.token);
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.storedFile.update({
        where: { id },
        data: {
          uploadExpiresAt: new Date(Date.now() - FINALIZE_GRACE_MS - 1000),
        },
      }),
    );
    expect(err(await f.finalize(me.token, id).expect(409)).code).toBe(
      'FILE_UPLOAD_EXPIRED',
    );
  });

  it("a file is its owner's alone", async () => {
    const me = await someone();
    const id = await f.ready(me.token);
    for (const token of [
      w.a.tokens.owner,
      w.a.tokens.family,
      w.a.tokens.manager,
      w.a.tokens.tenant,
    ]) {
      expect(err(await get(token, id).expect(404)).code).toBe('FILE_NOT_FOUND');
      await f.finalize(token, id).expect(404);
      await call(w, 'DELETE', `/files/${id}`, { token }).expect(404);
    }
    await get(me.token, id).expect(200);
  });

  it("another compound's file is not there, even by id (RLS)", async () => {
    const seen = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.storedFile.findUnique({
        where: { id: w.bFileId },
      }),
    );
    expect(seen).toBeNull();
  });

  it('delete: the object, then the row; audited', async () => {
    const me = await someone();
    const id = await f.ready(me.token);
    expect(await storage.head(key(id))).not.toBeNull();

    await call(w, 'DELETE', `/files/${id}`, { token: me.token }).expect(204);
    expect(await storage.head(key(id))).toBeNull();
    expect(await row(id)).toBeNull();
    await get(me.token, id).expect(404);
    await call(w, 'DELETE', `/files/${id}`, { token: me.token }).expect(404);

    const [deleted] = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'file.deleted',
      targetId: id,
    });
    expect(deleted).toMatchObject({
      actorId: me.id,
      targetType: 'file',
      metadata: { purpose: 'worker_photo', reasonCode: 'owner' },
    });
  });

  it(`at most ${PENDING_LIMIT} unfinalized uploads, even in parallel`, async () => {
    const me = await someone();
    const statuses = await Promise.all(
      Array.from({ length: PENDING_LIMIT + 5 }, () =>
        call(w, 'POST', '/files/uploads', {
          token: me.token,
          body: { purpose: 'worker_photo', contentType: 'image/png', size: 9 },
        }).then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(PENDING_LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    const refused = await call(w, 'POST', '/files/uploads', {
      token: me.token,
      body: { purpose: 'worker_photo', contentType: 'image/png', size: 9 },
    }).expect(429);
    expect(err(refused)).toMatchObject({
      code: 'FILE_PENDING_LIMIT',
      params: { limit: PENDING_LIMIT },
    });

    // An expired one stops counting; a finalized one never did.
    const [oldest] = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.storedFile.findMany({
        where: { ownerAccountId: me.id },
        take: 1,
      }),
    );
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.storedFile.update({
        where: { id: oldest.id },
        data: {
          uploadExpiresAt: new Date(Date.now() - FINALIZE_GRACE_MS - 1000),
        },
      }),
    );
    const id = await f.uploaded(me.token);
    await f.finalize(me.token, id).expect(200);
    await f.declare(me.token, 'worker_photo', 'image/png', 9);
  });

  it('two finalizes at once: both succeed, one transition', async () => {
    const me = await someone();
    const id = await f.uploaded(me.token);
    const [one, two] = await Promise.all([
      f.finalize(me.token, id),
      f.finalize(me.token, id),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect((await row(id))?.status).toBe('ready');
  });

  it('finalize racing delete: the file ends deleted either way', async () => {
    const me = await someone();
    const id = await f.uploaded(me.token);
    const [fin, del] = await Promise.all([
      f.finalize(me.token, id),
      call(w, 'DELETE', `/files/${id}`, { token: me.token }),
    ]);
    expect(del.status).toBe(204);
    expect([200, 404]).toContain(fin.status);
    expect(await row(id)).toBeNull();
    expect(await storage.head(key(id))).toBeNull();
    await get(me.token, id).expect(404);
  });
});
