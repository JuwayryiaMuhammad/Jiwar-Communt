import { AccountsService } from '../../src/core/accounts/accounts.service';
import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import {
  DATA_EXPORT_EXPIRE_SWEEP,
  DataExportsService,
  EXPORT_TTL_MS,
} from '../../src/core/exports/data-exports.service';
import { FILES_SWEEP } from '../../src/core/files/files.service';
import { ObjectStorage, objectKey } from '../../src/core/files/object-storage';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { WorkersService } from '../../src/community/workers/workers.service';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
import { MessagesService } from '../../src/maintenance/tickets/messages.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { fileHelpers, SAMPLE } from '../setup/files';
import { codeOf, nationalIdFor } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

const DAY = 86_400_000;

/**
 * Personal-data export (ADR 0036): behind a fresh step-up, one active
 * request and one a day, built in the background into the private bucket,
 * downloadable for 7 days through a no-store presigned URL, then deleted.
 * The archive holds the account's own data and what it authored, as its
 * own views show them — never a household member's.
 */
describe('Personal-data export', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;
  let categoryId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('Export Court');
    categoryId = (
      await x.asManager(c, () =>
        x.prisma.tenant.ticketCategory.findFirstOrThrow({
          where: { key: 'plumbing' },
        }),
      )
    ).id;
  });

  afterAll(() => h.close());

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function someone() {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    return { ...p, unitId: unit.id, token };
  }

  const ask = (token: string) =>
    h.http().post(`${API}/me/data-exports`).set(bearer(token)).send({});

  async function exportOf(p: { token: string; email: string }) {
    await stepUp(h, p.token, p.email);
    const res = await ask(p.token).expect(201);
    return (res.body as { id: string }).id;
  }

  const row = (id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.dataExport.findUniqueOrThrow({ where: { id } }),
    );

  /** As if the account's last request was a day and a minute ago. */
  const aDayLater = (accountId: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.dataExport.updateMany({
        where: { accountId },
        data: { requestedAt: new Date(Date.now() - DAY - 60_000) },
      }),
    );

  // --------------------------------------------------------------------------
  it('needs a fresh step-up on the session, spent by the request', async () => {
    const p = await someone();
    const refused = await ask(p.token).expect(403);
    expect((refused.body as { code: string }).code).toBe('STEP_UP_REQUIRED');
    await stepUp(h, p.token, p.email);
    const created = await ask(p.token).expect(201);
    expect(Object.keys(created.body as object).sort()).toEqual([
      'assisted',
      'expiresAt',
      'id',
      'readyAt',
      'requestedAt',
      'status',
    ]);
    expect(created.body).toMatchObject({ status: 'pending', assisted: false });
    // Spent: the next request needs a new one.
    expect(
      ((await ask(p.token).expect(403)).body as { code: string }).code,
    ).toBe('STEP_UP_REQUIRED');
  });

  it('one active request; then at most one a day', async () => {
    const p = await someone();
    await exportOf(p);
    await stepUp(h, p.token, p.email);
    const active = await ask(p.token).expect(409);
    expect((active.body as { code: string }).code).toBe('DATA_EXPORT_ACTIVE');
    await buildExports(h);
    await stepUp(h, p.token, p.email);
    const limited = await ask(p.token).expect(429);
    expect(limited.body).toMatchObject({
      code: 'DATA_EXPORT_RATE_LIMITED',
      params: { retryAfter: expect.any(String) as string },
    });
    await aDayLater(p.id);
    await ask(p.token).expect(201);
  });

  it('two requests at once: one is filed', async () => {
    for (let i = 0; i < 3; i++) {
      const p = await someone();
      const second = await h.tokenFor({
        sub: p.id,
        tid: c.tenantId,
        typ: 'resident',
      });
      await stepUp(h, p.token, p.email);
      await stepUp(h, second, p.email);
      const results = await Promise.all([ask(p.token), ask(second)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await x.asManager(c, () =>
          x.prisma.tenant.dataExport.count({ where: { accountId: p.id } }),
        ),
      ).toBe(1);
    }
  });

  it('contains the account’s own data and what it authored, never a household member’s', async () => {
    const p = await someone();
    const family = await x.joinFamily(c, p.unitId, p);
    const familyToken = await h.tokenFor({
      sub: family.id,
      tid: c.tenantId,
      typ: 'family',
    });
    const asP = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: p.id, type: 'resident' }, fn);
    const asF = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: family.id, type: 'family' }, fn);

    // The account's own photo.
    const photo = await fileHelpers(h).ready(p.token, 'resident_photo');
    await h
      .http()
      .put(`${API}/me/photo`)
      .set(bearer(p.token))
      .send({ fileId: photo })
      .expect(204);
    // What each of them authored.
    const tickets = h.moduleRef.get(TicketsService);
    const pTicket = await asP(() =>
      tickets.create({
        unitId: p.unitId,
        categoryId,
        description: 'EXPORT-P-TICKET',
      }),
    );
    await asP(() =>
      h.moduleRef
        .get(MessagesService)
        .post(pTicket.id, 'resident', 'EXPORT-P-MESSAGE'),
    );
    await asF(() =>
      tickets.create({
        unitId: p.unitId,
        categoryId,
        description: 'EXPORT-F-TICKET',
      }),
    );
    const passes = h.moduleRef.get(VisitorPassesService);
    const visitorPhone = uniquePhone();
    const pass = (visitorName: string) => ({
      kind: 'one_time' as const,
      partySize: 1,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 3_600_000),
      visitorName,
      visitorPhone,
    });
    await asP(() => passes.create(p.unitId, pass('EXPORT-P-VISITOR')));
    await asF(() => passes.create(p.unitId, pass('EXPORT-F-VISITOR')));
    const workerDoc = nationalIdFor();
    const workerPhone = uniquePhone();
    await asP(() =>
      h.moduleRef.get(WorkersService).register(p.unitId, {
        fullName: 'EXPORT-P-WORKER',
        idDocumentType: 'national_id',
        idDocumentNumber: workerDoc,
        phone: workerPhone,
        capacity: 'live_in',
      }),
    );
    void familyToken;

    const id = await exportOf(p);
    await buildExports(h);
    expect((await row(id)).status).toBe('ready');
    const dl = await h
      .http()
      .get(`${API}/me/data-exports/${id}/download`)
      .set(bearer(p.token))
      .expect(200);
    expect(dl.headers['cache-control']).toBe('no-store');
    const archive = await readArchive((dl.body as { url: string }).url);

    expect(archive.names).toEqual(
      expect.arrayContaining([
        'README.json',
        'account.json',
        'notification-preferences.json',
        'consents.json',
        'sessions.json',
        'deletion-requests.json',
        'units.json',
        'delegations.json',
        'workers.json',
        'visitor-passes.json',
        'entry-credentials.json',
        'files/photo.png',
      ]),
    );
    expect(archive.names.filter((n) => n.startsWith('tickets/'))).toHaveLength(
      1,
    );
    const account = JSON.parse(archive.text('account.json')) as Record<
      string,
      unknown
    >;
    expect(account).toMatchObject({
      id: p.id,
      phone: p.phone,
      email: p.email,
      photoUrl: null,
    });
    expect(archive.bytes('files/photo.png').equals(SAMPLE['image/png'])).toBe(
      true,
    );
    for (const mine of [
      'EXPORT-P-TICKET',
      'EXPORT-P-MESSAGE',
      'EXPORT-P-VISITOR',
      'EXPORT-P-WORKER',
    ])
      expect([mine, archive.all.includes(mine)]).toEqual([mine, true]);
    for (const theirs of [
      'EXPORT-F-TICKET',
      'EXPORT-F-VISITOR',
      family.fullName,
      family.phone,
      family.email,
      family.idDocumentNumber,
      // Other people's government ID, phone (ADR 0036)…
      workerDoc,
      workerPhone,
      visitorPhone,
      // …and the account's own document number, masked as in GET /me.
      p.idDocumentNumber,
      // No presigned URL inside the archive.
      'X-Amz-',
    ])
      expect([theirs, archive.all.includes(theirs)]).toEqual([theirs, false]);
  });

  it('the inbox says it is ready, with no link', async () => {
    const p = await someone();
    const id = await exportOf(p);
    await buildExports(h);
    const [n] = await x.asManager(c, () =>
      x.prisma.tenant.notification.findMany({
        where: { accountId: p.id, kind: 'data_export.ready' },
      }),
    );
    expect(n).toMatchObject({ targetType: 'data_export', targetId: id });
    expect(Object.keys(n.params as object)).toEqual(['expiresAt']);
    expect(JSON.stringify(n)).not.toMatch(/https?:|X-Amz/);
  });

  it('is deleted from storage after 7 days', async () => {
    const p = await someone();
    const id = await exportOf(p);
    await buildExports(h);
    const ready = await row(id);
    const key = objectKey({ tenantId: c.tenantId, id: ready.fileId! });
    const storage = h.moduleRef.get(ObjectStorage);
    expect(await storage.head(key)).not.toBeNull();

    const sweep = h.moduleRef.get(SweepRunner);
    await sweep.run(
      DATA_EXPORT_EXPIRE_SWEEP,
      new Date(Date.now() + EXPORT_TTL_MS - 60_000),
    );
    expect((await row(id)).status).toBe('ready');
    await sweep.run(
      DATA_EXPORT_EXPIRE_SWEEP,
      new Date(Date.now() + EXPORT_TTL_MS + 60_000),
    );
    expect(await row(id)).toMatchObject({ status: 'expired', fileId: null });
    await sweep.run(FILES_SWEEP, new Date(Date.now() + EXPORT_TTL_MS + 60_000));
    expect(await storage.head(key)).toBeNull();
    expect(
      await x.asManager(c, () =>
        x.prisma.tenant.storedFile.findUnique({ where: { id: ready.fileId! } }),
      ),
    ).toBeNull();
    const gone = await h
      .http()
      .get(`${API}/me/data-exports/${id}/download`)
      .set(bearer(p.token))
      .expect(404);
    expect((gone.body as { code: string }).code).toBe('DATA_EXPORT_NOT_FOUND');
  });

  it('another account’s export, or one not ready, is not found', async () => {
    const p = await someone();
    const q = await someone();
    const id = await exportOf(p);
    for (const token of [p.token, q.token]) {
      const res = await h
        .http()
        .get(`${API}/me/data-exports/${id}/download`)
        .set(bearer(token))
        .expect(404);
      expect((res.body as { code: string }).code).toBe('DATA_EXPORT_NOT_FOUND');
    }
    await buildExports(h);
    await h
      .http()
      .get(`${API}/me/data-exports/${id}/download`)
      .set(bearer(q.token))
      .expect(404);
    const list = await h
      .http()
      .get(`${API}/me/data-exports`)
      .set(bearer(q.token))
      .expect(200);
    expect((list.body as { data: unknown[] }).data).toEqual([]);
  });

  it('a frozen or erased account cannot file one; an erasure ends its exports', async () => {
    const service = h.moduleRef.get(DataExportsService);
    const file = (accountId: string) =>
      x.as(c, { id: accountId, type: 'resident' }, () =>
        h.moduleRef
          .get(TenantTx)
          .withTenantTx((tx) => service.file(tx, accountId, null, new Date())),
      );
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    const frozen = await x.resident(c, [unit.id], 'tenant');
    await x.asManager(c, () =>
      h.moduleRef
        .get(AccountsService)
        .freeze(frozen.id, { code: 'phone_reassigned', text: 'New owner' }),
    );
    expect(await codeOf(file(frozen.id))).toBe('ACCOUNT_NOT_ELIGIBLE');

    const leaving = await x.resident(c, [unit.id], 'tenant');
    const token = await h.tokenFor({
      sub: leaving.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    const id = await exportOf({ token, email: leaving.email });
    await buildExports(h);
    const ready = await row(id);
    await eraseNow(h, c, leaving.id);
    expect(await row(id)).toMatchObject({ status: 'expired', fileId: null });
    expect(
      await h.moduleRef
        .get(ObjectStorage)
        .head(objectKey({ tenantId: c.tenantId, id: ready.fileId! })),
    ).toBeNull();
    expect(await codeOf(file(leaving.id))).toBe('ACCOUNT_NOT_ELIGIBLE');
  });

  it('a build that died is taken again and its object replaced', async () => {
    const p = await someone();
    const id = await exportOf(p);
    // As if a build had claimed it and its process had died.
    const staleObject = newId();
    await x.asManager(c, () =>
      x.prisma.tenant.dataExport.update({
        where: { id },
        data: {
          status: 'building',
          attempts: 1,
          objectId: staleObject,
          lockedUntil: new Date(Date.now() - 1000),
        },
      }),
    );
    await buildExports(h);
    const ready = await row(id);
    expect(ready).toMatchObject({ status: 'ready', attempts: 2 });
    expect(ready.fileId).not.toBe(staleObject);
  });

  it('audits every step with ids and codes, never content', async () => {
    const p = await someone();
    const id = await exportOf(p);
    await buildExports(h);
    await h
      .http()
      .get(`${API}/me/data-exports/${id}/download`)
      .set(bearer(p.token))
      .expect(200);
    const rows = (await auditReaders(h).tenant(c.tenantId)).filter(
      (r) => r.targetId === id,
    );
    expect(rows.map((r) => r.action)).toEqual([
      'data_export.requested',
      'data_export.ready',
      'data_export.downloaded',
    ]);
    const text = JSON.stringify(rows);
    for (const s of [p.phone, p.email, p.fullName, 'X-Amz', 'http'])
      expect([s, text.includes(s)]).toEqual([s, false]);
  });
});
