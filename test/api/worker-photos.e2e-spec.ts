import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { WORKER_PHOTO_RETENTION_SWEEP } from '../../src/community/workers/photo-retention';
import { FILES_SWEEP, objectKey } from '../../src/core/files/files.service';
import { ObjectStorage } from '../../src/core/files/object-storage';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import { fileHelpers, SAMPLE } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { call, err } from './request';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

interface Photo {
  url: string;
  expiresAt: string;
}
interface Issued {
  engagementId: string;
  accessCode: string;
  card: { photo: Photo | null; preferredLanguage: string; qrPayload: string };
}

/** Worker photos and the card's language (ADR 0029, 0030). */
describe('API v0 — worker photos', () => {
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

  const manager = () => w.a.tokens.manager;
  const key = (id: string) => objectKey({ tenantId: w.a.tenantId, id });
  /** A live-in worker body (no schedule: always allowed at the gate). */
  const liveIn = (extra: object = {}) => {
    const { schedule, ...rest } = workerBody();
    void schedule;
    return { ...rest, capacity: 'live_in', ...extra };
  };

  /** A resident of a fresh unit in A, with a token. */
  async function household() {
    const unit = await w.helpers.unit(w.a);
    const r = await w.helpers.resident(w.a, [unit.id]);
    return {
      id: r.id,
      unitId: unit.id,
      token: await w.tokenFor(w.a, r.id, 'resident'),
    };
  }

  async function register(
    hh: { unitId: string; token: string },
    body: object,
  ): Promise<string> {
    const res = await call(w, 'POST', `/units/${hh.unitId}/workers`, {
      token: hh.token,
      body,
    }).expect(201);
    return (res.body as { engagementId: string }).engagementId;
  }

  const approve = async (engagementId: string) =>
    (
      await call(w, 'POST', `/worker-engagements/${engagementId}/review`, {
        token: manager(),
        body: { decision: 'approve' },
      }).expect(200)
    ).body as Issued;

  const detail = async (engagementId: string) => {
    const res = await call(w, 'GET', `/worker-engagements/${engagementId}`, {
      token: manager(),
    }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return res.body as { worker: { id: string; photo: Photo | null } };
  };

  /** The photo URL names this file, and the store serves the bytes. */
  async function shows(photo: Photo | null, fileId: string) {
    expect(photo).not.toBeNull();
    expect(new URL(photo!.url).pathname).toMatch(
      new RegExp(`/${key(fileId)}$`),
    );
    expect(new URL(photo!.url).searchParams.get('X-Amz-Expires')).toBe('300');
    const res = await fetch(photo!.url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(SAMPLE['image/png']);
  }

  const verify = (body: object) =>
    call(w, 'POST', '/gate/verify', { token: w.a.tokens.guard, body });

  it('registered with a photo and a language: the card, the detail and the gate show it', async () => {
    const hh = await household();
    const photo = await f.ready(hh.token);
    const engagementId = await register(
      hh,
      liveIn({ photoFileId: photo, preferredLanguage: 'en' }),
    );

    // The file is the worker's now: its uploader no longer reaches it.
    await call(w, 'GET', `/files/${photo}`, { token: hh.token }).expect(404);
    await call(w, 'DELETE', `/files/${photo}`, { token: hh.token }).expect(404);

    const [registered] = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'worker.registered',
      targetId: engagementId,
    });
    expect(registered.changes).toMatchObject({ photo: { changed: true } });
    expect(JSON.stringify(registered)).not.toContain(photo);

    await shows((await detail(engagementId)).worker.photo, photo);
    const approved = await approve(engagementId);
    expect(approved.card.preferredLanguage).toBe('en');
    await shows(approved.card.photo, photo);

    // Every new code's card carries it.
    const reissued = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/reissue-code`,
      { token: hh.token, body: { reasonCode: 'compromised' } },
    ).expect(200);
    await shows((reissued.body as Issued).card.photo, photo);
    const incident = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/card-incident`,
      { token: manager(), body: { type: 'lost' } },
    ).expect(201);
    const card = (incident.body as Issued).card;
    await shows(card.photo, photo);

    // The guard compares the face: a valid code or QR shows the photo.
    const byCode = await verify({
      code: (incident.body as Issued).accessCode,
    }).expect(200);
    expect(byCode.headers['cache-control']).toBe('no-store');
    expect(byCode.body).toMatchObject({ result: 'valid', subject: 'worker' });
    await shows(
      (byCode.body as { display: { photo: Photo } }).display.photo,
      photo,
    );
    const byQr = await verify({ qr: card.qrPayload }).expect(200);
    await shows(
      (byQr.body as { display: { photo: Photo } }).display.photo,
      photo,
    );

    // Never for an invalid result.
    await call(w, 'POST', `/worker-engagements/${engagementId}/suspend`, {
      token: hh.token,
      body: { reasonCode: 'leave', reason: 'Away' },
    }).expect(204);
    const refused = await verify({ qr: card.qrPayload }).expect(200);
    expect(refused.body).toMatchObject({
      result: 'invalid',
      reason: 'suspended',
      display: { photo: null },
    });

    // Not in the residents' list.
    const list = await call(w, 'GET', `/units/${hh.unitId}/workers`, {
      token: hh.token,
    }).expect(200);
    expect(list.text).not.toContain(photo);
  });

  it('without a photo: `ar`, and null wherever a photo would be', async () => {
    const hh = await household();
    const engagementId = await register(hh, liveIn());
    expect((await detail(engagementId)).worker.photo).toBeNull();
    const approved = await approve(engagementId);
    expect(approved.card).toMatchObject({
      preferredLanguage: 'ar',
      photo: null,
    });
    const checked = await verify({ code: approved.accessCode }).expect(200);
    expect(checked.body).toMatchObject({
      result: 'valid',
      display: { photo: null },
    });
  });

  it('a language other than ar or en is refused', async () => {
    const hh = await household();
    const res = await call(w, 'POST', `/units/${hh.unitId}/workers`, {
      token: hh.token,
      body: liveIn({ preferredLanguage: 'fr' }),
    }).expect(400);
    expect(err(res).fields).toEqual([
      {
        field: 'preferredLanguage',
        code: 'INVALID_VALUE',
        params: { allowed: ['ar', 'en'] },
      },
    ]);
  });

  it("a photo that is not the caller's finalized worker photo: FILE_NOT_AVAILABLE, nothing registered", async () => {
    const hh = await household();
    const other = await household();
    const theirs = await f.ready(other.token);
    const pending = await f.uploaded(hh.token);
    const document = await f.ready(manager(), 'document', 'application/pdf');
    const unknown = '01a0f000-0000-7000-8000-00000000abcd';
    for (const photoFileId of [theirs, pending, document, unknown]) {
      const res = await call(w, 'POST', `/units/${hh.unitId}/workers`, {
        token: hh.token,
        body: liveIn({ photoFileId }),
      }).expect(400);
      expect(err(res).fields).toEqual([
        { field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' },
      ]);
    }
    const list = await call(w, 'GET', `/units/${hh.unitId}/workers`, {
      token: hh.token,
    }).expect(200);
    expect((list.body as { data: unknown[] }).data).toEqual([]);
    // Each file is where it was.
    await call(w, 'GET', `/files/${theirs}`, { token: other.token }).expect(
      200,
    );
    await call(w, 'GET', `/files/${pending}`, { token: hh.token }).expect(200);
  });

  it('a worker the compound knows keeps their photo; the new file is dropped, the answer the same', async () => {
    const first = await household();
    const body = liveIn();
    const firstPhoto = await f.ready(first.token);
    const one = await register(first, { ...body, photoFileId: firstPhoto });

    const second = await household();
    const secondPhoto = await f.ready(second.token);
    const res = await call(w, 'POST', `/units/${second.unitId}/workers`, {
      token: second.token,
      body: { ...body, photoFileId: secondPhoto, preferredLanguage: 'en' },
    }).expect(201);
    expect(Object.keys(res.body as object).sort()).toEqual([
      'engagementId',
      'status',
      'warnings',
    ]);
    const two = (res.body as { engagementId: string }).engagementId;

    await shows((await detail(one)).worker.photo, firstPhoto);
    await shows((await detail(two)).worker.photo, firstPhoto);
    await call(w, 'GET', `/files/${secondPhoto}`, {
      token: second.token,
    }).expect(404);
    expect(await storage.head(key(secondPhoto))).toBeNull();
    // The language stays the record's own.
    expect((await approve(two)).card.preferredLanguage).toBe('ar');
  });

  it('the manager sets and replaces a photo; the replaced one is deleted', async () => {
    const hh = await household();
    const engagementId = await register(hh, liveIn());
    const workerId = (await detail(engagementId)).worker.id;
    const put = (fileId: string, token = manager()) =>
      call(w, 'PUT', `/workers/${workerId}/photo`, { token, body: { fileId } });

    const first = await f.ready(manager());
    await put(first).expect(204);
    await shows((await detail(engagementId)).worker.photo, first);
    await call(w, 'GET', `/files/${first}`, { token: manager() }).expect(404);

    const second = await f.ready(manager());
    await put(second).expect(204);
    await shows((await detail(engagementId)).worker.photo, second);
    expect(await storage.head(key(first))).toBeNull();
    expect(
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.storedFile.findUnique({ where: { id: first } }),
      ),
    ).toBeNull();

    // An attached file, or a resident's, cannot be used again.
    for (const fileId of [second, await f.ready(hh.token)]) {
      expect(err(await put(fileId).expect(400)).fields).toEqual([
        { field: 'fileId', code: 'FILE_NOT_AVAILABLE' },
      ]);
    }
    // Residents do not set photos.
    expect(err(await put(second, hh.token).expect(403)).code).toBe('FORBIDDEN');
  });

  it("the uploader's erasure leaves the worker's photo", async () => {
    const hh = await household();
    const photo = await f.ready(hh.token);
    const engagementId = await register(hh, liveIn({ photoFileId: photo }));
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await w.helpers.as(
      w.a,
      { id: hh.id, type: 'resident' },
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
      deletion.erase(request.id, scopePhrase(hh.id)),
    );
    await shows((await detail(engagementId)).worker.photo, photo);
  });

  it('retention: the photo goes once no engagement has been open for the period', async () => {
    const sweep = h.moduleRef.get(SweepRunner);
    const age = (engagementId: string, days: number) =>
      w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.workerEngagement.update({
          where: { id: engagementId },
          data: { updatedAt: new Date(Date.now() - days * 86_400_000) },
        }),
      );
    const end = (engagementId: string) =>
      call(w, 'POST', `/worker-engagements/${engagementId}/end`, {
        token: manager(),
        body: { reasonCode: 'work_finished', reason: 'Done' },
      }).expect(204);

    const hh = await household();
    const open = await register(
      hh,
      liveIn({ photoFileId: await f.ready(hh.token) }),
    );
    await age(open, 400); // pending review, long ago: still open
    const recent = await register(
      hh,
      liveIn({ photoFileId: await f.ready(hh.token) }),
    );
    await end(recent);
    await age(recent, 89);
    const stalePhoto = await f.ready(hh.token);
    const stale = await register(hh, liveIn({ photoFileId: stalePhoto }));
    await end(stale);
    await age(stale, 91);

    await sweep.run(WORKER_PHOTO_RETENTION_SWEEP);
    expect((await detail(open)).worker.photo).not.toBeNull();
    expect((await detail(recent)).worker.photo).not.toBeNull();
    expect((await detail(stale)).worker.photo).toBeNull();
    // The files sweep deletes the object, then the row.
    await sweep.run(FILES_SWEEP);
    expect(await storage.head(key(stalePhoto))).toBeNull();
  });
});
