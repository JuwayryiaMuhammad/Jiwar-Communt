import { randomUUID } from 'node:crypto';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import {
  hashedBody,
  requestHash,
} from '../../src/core/idempotency/idempotency-key';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type PermitBody } from '../setup/permits';
import { HASH, permitFileRow, permitWorkerRow } from '../setup/permits-rows';
import { leakText } from '../setup/leak-text';

describe('Permits — contractor workers (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  /** A compound of the test's own: a unit holds three live works permits. */
  let n = 0;
  const court = () => p.setUp(`Workers Court ${(n += 1)}`);

  afterAll(() => h.close());

  const fields = (res: { body: unknown }) =>
    (res.body as { fields?: unknown }).fields;

  it('registered one by one: a name, a face, the ID type; the last four only as a keyed hash, shown to nobody', async () => {
    const s = await court();
    const permit = await p.works(s.alice, s.home.id);
    const res = p.status(
      await p.addWorkerRaw(s.alice, permit.id, {
        fullName: '  Mahmoud   Ali  ',
        idLast4: '4821',
      }),
      201,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(leakText(res.body)).not.toContain('4821');
    const body = res.body as PermitBody;
    expect(body.works).toMatchObject({ workerCount: 1 });
    const [w] = body.works!.workers;
    expect(w).toMatchObject({
      fullName: 'Mahmoud Ali',
      idType: 'national_id',
      photo: { url: expect.any(String) as string },
      removedAt: null,
      removedBy: null,
    });
    const row = await p.v.inTx(s.c, (tx) =>
      tx.permitWorker.findUniqueOrThrow({ where: { id: w.id } }),
    );
    expect(row.idLast4Hash).toBe(
      h.moduleRef
        .get(IdentifierHasher)
        .hashPermitWorkerIdLast4(s.c.tenantId, w.id, '4821'),
    );
    expect(row.idLast4Hash).not.toContain('4821');
    // The photo is the worker's now: attached, nobody's to delete.
    const file = await p.v.inTx(s.c, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: row.photoFileId! } }),
    );
    expect(file).toMatchObject({ ownerAccountId: null });
    expect(file.attachedAt).not.toBeNull();
    // Audited by ids and counts.
    const audit = await p.v.x.asManager(s.c, () =>
      p.v.x.prisma.tenant.auditLog.findMany({
        where: { action: 'unit_permit.worker_added', targetId: permit.id },
      }),
    );
    expect(audit.map((a) => a.metadata)).toEqual([
      { workerId: w.id, idType: 'national_id', workers: 1 },
    ]);
    expect(leakText(audit)).not.toMatch(/4821|Mahmoud/);
  });

  it('the last four: digits on a national ID, letters or digits on a passport', async () => {
    const s = await court();
    const permit = await p.works(s.alice, s.home.id);
    for (const [idType, idLast4] of [
      ['national_id', '12AB'],
      ['national_id', '123'],
      ['passport', 'AB-1'],
    ])
      expect(
        fields(
          p.status(
            await p.addWorkerRaw(s.alice, permit.id, { idType, idLast4 }),
            400,
          ),
        ),
      ).toEqual([{ field: 'idLast4', code: 'INVALID_FORMAT' }]);
    const { worker } = await p.addWorker(s.alice, permit.id, {
      idType: 'passport',
      idLast4: 'ab12',
    });
    expect(worker.idType).toBe('passport');
    const row = await p.v.inTx(s.c, (tx) =>
      tx.permitWorker.findUniqueOrThrow({ where: { id: worker.id } }),
    );
    expect(row.idLast4Hash).toBe(
      h.moduleRef
        .get(IdentifierHasher)
        .hashPermitWorkerIdLast4(s.c.tenantId, worker.id, 'AB12'),
    );
  });

  it('a face of the caller’s own, of its purpose, once', async () => {
    const s = await court();
    const permit = await p.works(s.alice, s.home.id);
    const wrong = await p.files.ready(s.alice.token, 'worker_photo');
    expect(
      fields(
        p.status(
          await p.addWorkerRaw(s.alice, permit.id, { photoFileId: wrong }),
          400,
        ),
      ),
    ).toEqual([{ field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' }]);
    const { worker } = await p.addWorker(s.alice, permit.id);
    const used = (
      await p.v.inTx(s.c, (tx) =>
        tx.permitWorker.findUniqueOrThrow({ where: { id: worker.id } }),
      )
    ).photoFileId!;
    expect(
      fields(
        p.status(
          await p.addWorkerRaw(s.alice, permit.id, { photoFileId: used }),
          400,
        ),
      ),
    ).toEqual([{ field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' }]);
  });

  it('thirty on a permit; removed ones do not count', async () => {
    const s = await court();
    const permit = await p.works(s.alice, s.home.id);
    await p.v.inTx(s.c, async (tx) => {
      for (let i = 0; i < 29; i += 1)
        await permitWorkerRow(tx, {
          tenantId: s.c.tenantId,
          permitId: permit.id,
          addedById: s.alice.id,
          photoFileId: await permitFileRow(tx, s.c.tenantId),
        });
    });
    const { worker } = await p.addWorker(s.alice, permit.id);
    expect(
      p.status(await p.addWorkerRaw(s.alice, permit.id), 409).body,
    ).toMatchObject({
      code: 'PERMIT_LIMIT_REACHED',
      params: { scope: 'workers', max: 30 },
    });
    await p
      .http(
        'post',
        `/permits/${permit.id}/workers/${worker.id}/remove`,
        s.alice.token,
        {},
      )
      .expect(200);
    p.status(await p.addWorkerRaw(s.alice, permit.id), 201);
    expect(HASH).toHaveLength(64);
  });

  it('taken off by the requester once; never on a permit that is over', async () => {
    const s = await court();
    const permit = await p.works(s.alice, s.home.id);
    const { worker } = await p.addWorker(s.alice, permit.id);
    const remove = () =>
      p.http(
        'post',
        `/permits/${permit.id}/workers/${worker.id}/remove`,
        s.alice.token,
        {},
      );
    const removed = (await remove().expect(200)).body as PermitBody;
    expect(removed.works).toMatchObject({ workerCount: 0 });
    expect(removed.works!.workers[0]).toMatchObject({
      removedBy: 'requester',
      removedAt: expect.any(String) as string,
    });
    await remove().expect(200);
    expect(
      await p.v.x.asManager(s.c, () =>
        p.v.x.prisma.tenant.auditLog.count({
          where: { action: 'unit_permit.worker_removed', targetId: permit.id },
        }),
      ),
    ).toBe(1);
    // Another permit's worker is not found by this one.
    const other = await p.works(s.alice, s.home.id);
    expect(
      (
        await p
          .http(
            'post',
            `/permits/${other.id}/workers/${worker.id}/remove`,
            s.alice.token,
            {},
          )
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'PERMIT_WORKER_NOT_FOUND' });
    await p
      .http('post', `/permits/${other.id}/cancel`, s.alice.token, {})
      .expect(200);
    expect(
      p.status(await p.addWorkerRaw(s.alice, other.id), 409).body,
    ).toMatchObject({
      code: 'PERMIT_NOT_ACTIVE',
      params: { status: 'cancelled' },
    });
  });

  it('nobody else in the unit adds or removes workers', async () => {
    const s = await court();
    const permit = await p.works(s.alice, s.home.id);
    const member = await p.family(s.c, s.home.id, s.alice);
    p.status(await p.addWorkerRaw(member, permit.id), 404);
    const other = await p.setUp('Workers Other Court');
    expect(
      p.status(await p.addWorkerRaw(other.alice, permit.id), 404).body,
    ).toMatchObject({ code: 'PERMIT_NOT_FOUND' });
  });

  it('a retry replays whatever its last four; the stored hash of the request cannot tell them (L1)', async () => {
    const s = await court();
    const permit = await p.works(s.alice, s.home.id);
    const key = randomUUID();
    const body = await p.workerBody(s.alice, { idLast4: '1111' });
    const send = (last4: string) =>
      p.http(
        'post',
        `/permits/${permit.id}/workers`,
        s.alice.token,
        { ...body, idLast4: last4 },
        { 'Idempotency-Key': key },
      );
    await send('1111').expect(201);
    const again = await send('2222').expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(
      await p.v.inTx(s.c, (tx) =>
        tx.permitWorker.count({ where: { permitId: permit.id } }),
      ),
    ).toBe(1);
    const stored = await p.v.inTx(s.c, (tx) =>
      tx.idempotencyKey.findFirstOrThrow({
        where: { key, accountId: s.alice.id },
      }),
    );
    for (let n = 0; n < 10_000; n += 1) {
      const last4 = String(n).padStart(4, '0');
      expect(
        requestHash(
          'POST',
          stored.route,
          { id: permit.id },
          { ...body, idLast4: last4 },
        ),
      ).not.toBe(stored.requestHash);
    }
    expect(stored.requestHash).toBe(
      requestHash(
        'POST',
        stored.route,
        { id: permit.id },
        hashedBody({ ...body, idLast4: '9999' }, ['idLast4']),
      ),
    );
    expect(leakText(stored)).not.toContain('1111');
  });
});
