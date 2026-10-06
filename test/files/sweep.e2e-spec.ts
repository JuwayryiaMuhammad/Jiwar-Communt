import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import {
  FILES_SWEEP,
  objectKey,
  PENDING_SWEEP_AFTER_MS,
} from '../../src/core/files/files.service';
import { ObjectStorage } from '../../src/core/files/object-storage';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { fileHelpers } from '../setup/files';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

/** The files sweep and erasure (ADR 0029, 0023), against the local MinIO. */
describe('Files — sweep and erasure', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let f: ReturnType<typeof fileHelpers>;
  let storage: ObjectStorage;
  let sweep: SweepRunner;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    f = fileHelpers(h);
    storage = h.moduleRef.get(ObjectStorage, { strict: false });
    sweep = h.moduleRef.get(SweepRunner);
    c = await x.compound('Files Sweep');
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => h.close());

  async function someone() {
    const unit = await x.unit(c);
    const r = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: r.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    return { id: r.id, token };
  }

  /** Someone who may be erased: not a unit's primary (ADR 0036). */
  async function erasable() {
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    const r = await x.resident(c, [unit.id], 'tenant');
    const token = await h.tokenFor({
      sub: r.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    return { id: r.id, token };
  }

  const key = (id: string) => objectKey({ tenantId: c.tenantId, id });
  const row = (id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.storedFile.findUnique({ where: { id } }),
    );
  const expiredAgo = (id: string, ms: number) =>
    x.asManager(c, () =>
      x.prisma.tenant.storedFile.update({
        where: { id },
        data: { uploadExpiresAt: new Date(Date.now() - ms) },
      }),
    );
  const remove = (token: string, id: string) =>
    h
      .http()
      .delete(`${API}/files/${id}`)
      .set('Authorization', `Bearer ${token}`);

  it('an upload never finalized: marked, then its object and its row go', async () => {
    const me = await someone();
    const stale = await f.uploaded(me.token);
    const recent = await f.uploaded(me.token);
    const ready = await f.ready(me.token);
    await expiredAgo(stale, PENDING_SWEEP_AFTER_MS + 1000);
    await expiredAgo(recent, PENDING_SWEEP_AFTER_MS - 60_000);
    await expiredAgo(ready, PENDING_SWEEP_AFTER_MS * 2);

    expect(await sweep.run(FILES_SWEEP)).toBeGreaterThanOrEqual(2);
    expect(await row(stale)).toBeNull();
    expect(await storage.head(key(stale))).toBeNull();
    // Not yet due, and a finalized file is never swept.
    expect((await row(recent))?.status).toBe('pending');
    expect((await row(ready))?.status).toBe('ready');
    expect(await storage.head(key(ready))).not.toBeNull();

    const [deleted] = await auditReaders(h).tenant(c.tenantId, {
      action: 'file.deleted',
      targetId: stale,
    });
    expect(deleted).toMatchObject({
      actorType: 'system',
      actorId: null,
      metadata: { purpose: 'worker_photo', reasonCode: 'upload_expired' },
    });
    // Idempotent: nothing left to do for these.
    await sweep.run(FILES_SWEEP);
    expect(
      await auditReaders(h).tenant(c.tenantId, {
        action: 'file.deleted',
        targetId: stale,
      }),
    ).toHaveLength(1);
  });

  it('an object the store would not delete keeps its row until it is gone', async () => {
    const me = await someone();
    const id = await f.ready(me.token);
    const failing = jest.spyOn(storage, 'delete').mockResolvedValue(false);

    await remove(me.token, id).expect(204);
    expect((await row(id))?.deletedAt).not.toBeNull();
    expect(await storage.head(key(id))).not.toBeNull();
    await sweep.run(FILES_SWEEP);
    expect((await row(id))?.deletedAt).not.toBeNull();

    failing.mockRestore();
    await sweep.run(FILES_SWEEP);
    expect(await row(id)).toBeNull();
    expect(await storage.head(key(id))).toBeNull();
  });

  it('a file a finalize holds is skipped, and finalize then sees the deletion', async () => {
    const me = await someone();
    const id = await f.uploaded(me.token);
    await expiredAgo(id, PENDING_SWEEP_AFTER_MS + 1000);

    // Hold the row's lock the way finalize does, across a sweep run.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = x.asManager(c, () =>
      h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        await tx.$queryRaw`SELECT id FROM files WHERE id = ${id}::uuid FOR UPDATE`;
        locked();
        await held;
      }),
    );
    await isLocked;
    await sweep.run(FILES_SWEEP);
    expect((await row(id))?.deletedAt).toBeNull();
    release();
    await holder;

    await sweep.run(FILES_SWEEP);
    expect(await row(id)).toBeNull();
    await f.finalize(me.token, id).expect(404);
  });

  it("erasure takes the account's own files, ready and pending", async () => {
    const me = await erasable();
    const ready = await f.ready(me.token);
    const pending = await f.uploaded(me.token);
    const other = await someone();
    const kept = await f.ready(other.token);

    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await x.as(c, { id: me.id, type: 'resident' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await x.asManager(c, () =>
      x.prisma.tenant.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    await x.asManager(c, () => deletion.erase(request.id, scopePhrase(me.id)));

    for (const id of [ready, pending]) {
      expect(await row(id)).toBeNull();
      expect(await storage.head(key(id))).toBeNull();
      const [deleted] = await auditReaders(h).tenant(c.tenantId, {
        action: 'file.deleted',
        targetId: id,
      });
      expect(deleted).toMatchObject({
        actorId: c.managerId,
        metadata: { purpose: 'worker_photo', reasonCode: 'erasure' },
      });
    }
    expect((await row(kept))?.status).toBe('ready');
    expect(await storage.head(key(kept))).not.toBeNull();
  });

  it('an erasure that rolls back deletes nothing', async () => {
    const me = await erasable();
    const id = await f.ready(me.token);
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await x.as(c, { id: me.id, type: 'resident' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await x.asManager(c, () =>
      x.prisma.tenant.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    // The erasure's transaction fails after the hooks ran: nothing of the
    // file may be gone, since its object is deleted only after commit.
    const spy = jest
      .spyOn(h.moduleRef.get(TenantTx), 'withTenantTx')
      .mockImplementationOnce(async (fn) => {
        const real = TenantTx.prototype.withTenantTx.bind(
          h.moduleRef.get(TenantTx),
        );
        return real(async (tx) => {
          await fn(tx);
          throw new Error('rolled back');
        });
      });
    await expect(
      x.asManager(c, () => deletion.erase(request.id, scopePhrase(me.id))),
    ).rejects.toThrow('rolled back');
    spy.mockRestore();

    expect((await row(id))?.deletedAt).toBeNull();
    expect(await storage.head(key(id))).not.toBeNull();
  });
});
