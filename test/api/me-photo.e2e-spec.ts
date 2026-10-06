import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { objectKey } from '../../src/core/files/files.service';
import { ObjectStorage } from '../../src/core/files/object-storage';
import { auditReaders } from '../setup/audit';
import { fileHelpers, SAMPLE } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { call, err } from './request';
import { buildWorld, type World } from './world';

interface Me {
  id: string;
  photoUrl: string | null;
}

/** A resident's own photo (ADR 0031). */
describe('API v0 — my photo', () => {
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

  const key = (id: string) => objectKey({ tenantId: w.a.tenantId, id });

  /** A resident of a fresh unit in A, with a token. */
  async function resident() {
    const unit = await w.helpers.unit(w.a);
    const r = await w.helpers.resident(w.a, [unit.id]);
    return { id: r.id, token: await w.tokenFor(w.a, r.id, 'resident') };
  }

  const me = async (token: string) => {
    const res = await call(w, 'GET', '/me', { token }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return res.body as Me;
  };
  const set = (token: string, fileId: string) =>
    call(w, 'PUT', '/me/photo', { token, body: { fileId } });
  const row = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.storedFile.findUnique({ where: { id } }),
    );

  /** The URL names this file, and the store serves the bytes. */
  async function shows(url: string | null, fileId: string) {
    expect(url).not.toBeNull();
    expect(new URL(url!).pathname).toMatch(new RegExp(`/${key(fileId)}$`));
    const res = await fetch(url!);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(SAMPLE['image/png']);
  }

  it('set: the file moves to the account; only GET /me shows it; the audit never names the file', async () => {
    const r = await resident();
    expect((await me(r.token)).photoUrl).toBeNull();
    const photo = await f.ready(r.token, 'resident_photo');
    await set(r.token, photo).expect(204);

    await shows((await me(r.token)).photoUrl, photo);
    // The uploader no longer reaches the file through /files.
    await call(w, 'GET', `/files/${photo}`, { token: r.token }).expect(404);
    await call(w, 'DELETE', `/files/${photo}`, { token: r.token }).expect(404);

    const entries = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'account.photo_changed',
      targetId: r.id,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].changes).toEqual({ photo: { changed: true } });
    expect(JSON.stringify(entries[0])).not.toContain(photo);
  });

  it('replace: the old file and its object are gone', async () => {
    const r = await resident();
    const first = await f.ready(r.token, 'resident_photo');
    await set(r.token, first).expect(204);
    const second = await f.ready(r.token, 'resident_photo', 'image/png');
    await set(r.token, second).expect(204);

    await shows((await me(r.token)).photoUrl, second);
    expect(await storage.head(key(first))).toBeNull();
    expect(await row(first)).toBeNull();
    // An attached file cannot be used again.
    expect(err(await set(r.token, second).expect(400)).fields).toEqual([
      { field: 'fileId', code: 'FILE_NOT_AVAILABLE' },
    ]);
  });

  it('remove: the photo, its file and its object go; removing nothing is fine', async () => {
    const r = await resident();
    const photo = await f.ready(r.token, 'resident_photo');
    await set(r.token, photo).expect(204);
    await call(w, 'DELETE', '/me/photo', { token: r.token }).expect(204);

    expect((await me(r.token)).photoUrl).toBeNull();
    expect(await storage.head(key(photo))).toBeNull();
    expect(await row(photo)).toBeNull();
    await call(w, 'DELETE', '/me/photo', { token: r.token }).expect(204);
  });

  it("a file that is not the caller's finalized resident photo: FILE_NOT_AVAILABLE, nothing changes", async () => {
    const r = await resident();
    const other = await resident();
    const mine = await f.ready(r.token, 'resident_photo');
    await set(r.token, mine).expect(204);

    const theirs = await f.ready(other.token, 'resident_photo');
    const pending = await f.uploaded(r.token, 'resident_photo');
    const workerPhoto = await f.ready(w.a.tokens.owner, 'worker_photo');
    const unknown = '01a0f000-0000-7000-8000-00000000abcd';
    for (const fileId of [theirs, pending, workerPhoto, unknown]) {
      expect(err(await set(r.token, fileId).expect(400)).fields).toEqual([
        { field: 'fileId', code: 'FILE_NOT_AVAILABLE' },
      ]);
    }
    await shows((await me(r.token)).photoUrl, mine);
    // Each file is where it was.
    await call(w, 'GET', `/files/${theirs}`, { token: other.token }).expect(
      200,
    );
    await call(w, 'GET', `/files/${pending}`, { token: r.token }).expect(200);
  });

  it('limits: images only, 5 MB', async () => {
    const r = await resident();
    const asPdf = await h
      .http()
      .post('/api/v1/files/uploads')
      .set('Authorization', `Bearer ${r.token}`)
      .send({
        purpose: 'resident_photo',
        contentType: 'application/pdf',
        size: 100,
      })
      .expect(400);
    expect(err(asPdf).fields?.[0]).toMatchObject({
      field: 'contentType',
      code: 'FILE_TYPE_NOT_ALLOWED',
    });
    const big = await h
      .http()
      .post('/api/v1/files/uploads')
      .set('Authorization', `Bearer ${r.token}`)
      .send({
        purpose: 'resident_photo',
        contentType: 'image/png',
        size: 5 * 1024 * 1024 + 1,
      })
      .expect(400);
    expect(err(big).fields?.[0]).toMatchObject({
      field: 'size',
      code: 'FILE_TOO_LARGE',
    });
  });

  it('who may: residents and family; a guard and a manager neither upload nor set one', async () => {
    const family = w.a.tokens.family;
    const photo = await f.ready(family, 'resident_photo');
    await set(family, photo).expect(204);
    await shows((await me(family)).photoUrl, photo);
    await call(w, 'DELETE', '/me/photo', { token: family }).expect(204);

    for (const token of [w.a.tokens.guard, w.a.tokens.manager]) {
      for (const res of [
        await h
          .http()
          .post('/api/v1/files/uploads')
          .set('Authorization', `Bearer ${token}`)
          .send({
            purpose: 'resident_photo',
            contentType: 'image/png',
            size: 100,
          }),
        await set(token, photo),
        await call(w, 'DELETE', '/me/photo', { token }),
      ]) {
        expect(res.status).toBe(403);
      }
    }
  });

  it("another compound's photo cannot be used", async () => {
    const r = await resident();
    const foreign = await f.ready(w.b.tokens.owner, 'resident_photo');
    expect(err(await set(r.token, foreign).expect(400)).fields).toEqual([
      { field: 'fileId', code: 'FILE_NOT_AVAILABLE' },
    ]);
  });

  it("the account's erasure drops its photo: pointer, file and object", async () => {
    // Not a primary: a primary is not erased (ADR 0036).
    const unit = await w.helpers.unit(w.a);
    await w.helpers.resident(w.a, [unit.id]);
    const tenant = await w.helpers.resident(w.a, [unit.id], 'tenant');
    const r = {
      id: tenant.id,
      token: await w.tokenFor(w.a, tenant.id, 'resident'),
    };
    const photo = await f.ready(r.token, 'resident_photo');
    await set(r.token, photo).expect(204);
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await w.helpers.as(
      w.a,
      { id: r.id, type: 'resident' },
      () => deletion.requestDeletion('DELETE'),
    );
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    await w.helpers.asManager(w.a, () =>
      deletion.erase(request.id, scopePhrase(r.id)),
    );
    const account = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.account.findUniqueOrThrow({
        where: { id: r.id },
      }),
    );
    expect(account).toMatchObject({ status: 'erased', photoFileId: null });
    expect(await storage.head(key(photo))).toBeNull();
    expect(await row(photo)).toBeNull();
  });
});
