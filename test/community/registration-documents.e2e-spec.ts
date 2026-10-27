import { IdentifierHasher } from '../../src/core/auth/identifier';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  REGISTRATION_EXPIRY_SWEEP,
  RegistrationService,
  type RegistrationRequest,
} from '../../src/community/residents/registration.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { daysLater } from '../setup/compound-clock';
import { SAMPLE } from '../setup/files';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';

/**
 * A registrant's documents, status link and corrections (ADR 0062): no
 * account, the emailed link is the credential until the decision.
 */
describe('Registration documents and the status link', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let reg: RegistrationService;
  let globalDb: GlobalDbService;
  let hasher: IdentifierHasher;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    reg = h.moduleRef.get(RegistrationService);
    globalDb = h.moduleRef.get(GlobalDbService);
    hasher = h.moduleRef.get(IdentifierHasher);
  });

  afterAll(() => h.close());

  async function compound() {
    const c = await x.compound('Documents Court');
    const { token } = await x.asManager(c, () => reg.createLink());
    return { c, linkToken: token };
  }

  function request(
    linkToken: string,
    unitCode: string,
    over: Partial<RegistrationRequest> = {},
  ): RegistrationRequest {
    return {
      linkToken,
      fullName: `Registrant ${uniqueSuffix()}`,
      unitCode,
      phone: uniquePhone(),
      email: uniqueEmail('regdoc'),
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(),
      occupancyType: 'tenant',
      ...over,
    };
  }

  /** Start → code → complete; returns the request's id. */
  async function register(c: Compound, r: RegistrationRequest) {
    const since = new Date();
    await reg.start(r, '10.20.30.41', 'en');
    const code = await waitForOtp(r.email, since);
    await reg.complete(r, code, '10.20.30.41');
    const row = await x.asManager(c, () =>
      x.prisma.tenant.residentRegistration.findFirstOrThrow({
        where: { email: r.email },
      }),
    );
    return row.id;
  }

  const row = (c: Compound, id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.residentRegistration.findUniqueOrThrow({ where: { id } }),
    );

  /** The token the newest email carries, as its renderer derives it. */
  async function tokenOf(c: Compound, id: string) {
    const r = await row(c, id);
    return hasher.registrationStatusToken(c.tenantId, id, r.statusLinkSeq);
  }

  /** What the public routes answer, as far as these tests read it. */
  interface Body {
    code?: string;
    fields?: { code: string }[];
    status?: string;
    ready?: boolean;
    correctionCodes?: string[];
    documents?: unknown[];
    document?: { id: string; ready: boolean };
    upload?: { url: string; headers: Record<string, string> };
  }

  /** A fresh address per call: the per-IP limit is not what these test. */
  const anyIp = () =>
    `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

  async function post(path: string, body: object, ip = anyIp()) {
    const res = await h
      .http()
      .post(`${API}/public/registrations/${path}`)
      .set('X-Forwarded-For', ip)
      .send(body);
    return {
      status: res.status,
      headers: res.headers as Record<string, string>,
      body: res.body as Body,
    };
  }

  async function upload(
    token: string,
    contentType = 'application/pdf',
    body: Buffer = SAMPLE[contentType],
    kind = 'lease_proof',
  ) {
    const res = await post('uploads', {
      token,
      kind,
      contentType,
      size: body.length,
    });
    return res;
  }

  /** Uploaded and finalized: a ready document's id. */
  async function readyDocument(token: string) {
    const started = await upload(token);
    expect(started.status).toBe(201);
    const put = await fetch(started.body.upload!.url, {
      method: 'PUT',
      body: new Uint8Array(SAMPLE['application/pdf']),
      headers: started.body.upload!.headers,
    });
    expect(put.status).toBe(200);
    const done = await post(`documents/${started.body.document!.id}/finalize`, {
      token,
    });
    expect(done.status).toBe(200);
    expect(done.body.ready).toBe(true);
    return started.body.document!.id;
  }

  const liveFiles = (c: Compound, id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.registrationDocument.count({
        where: { registrationId: id, file: { deletedAt: null } },
      }),
    );

  it('completing emails a status link derived at send time; the outbox holds ids only', async () => {
    const { c, linkToken } = await compound();
    const id = await register(c, request(linkToken, 'D-1'));
    const token = await tokenOf(c, id);
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'community.registration_received',
      },
    });
    expect(mail.params).toMatchObject({
      tenantId: c.tenantId,
      registrationId: id,
      seq: 1,
      unitCode: 'D-1',
    });
    expect(JSON.stringify(mail)).not.toContain(token);

    const res = await post('status', { token });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toMatchObject({
      status: 'pending',
      unitCode: 'D-1',
      occupancyType: 'tenant',
      correctionCodes: [],
      documents: [],
      maxDocuments: 3,
    });
    // No personal data on the page: the link proves only the email.
    expect(JSON.stringify(res.body)).not.toMatch(/Registrant|@/);

    // Every miss is the same 404.
    for (const bad of ['x', 'f'.repeat(64), token.toUpperCase()]) {
      const miss = await post('status', { token: bad });
      expect([miss.status, miss.body.code]).toEqual([
        404,
        'REGISTRATION_STATUS_NOT_FOUND',
      ]);
    }
  });

  it('uploads: three live at most, bytes sniffed at finalize, a wrong one removed', async () => {
    const { c, linkToken } = await compound();
    const id = await register(c, request(linkToken, 'D-2'));
    const token = await tokenOf(c, id);

    const first = await readyDocument(token);
    // Declared a PDF, sent a PNG: refused at finalize and deleted.
    const lying = await upload(token, 'application/pdf');
    await fetch(lying.body.upload!.url, {
      method: 'PUT',
      // The declared size, a PNG's first bytes.
      body: new Uint8Array(
        SAMPLE['image/png'].subarray(0, SAMPLE['application/pdf'].length),
      ),
      headers: lying.body.upload!.headers,
    });
    const refused = await post(
      `documents/${lying.body.document!.id}/finalize`,
      {
        token,
      },
    );
    expect([refused.status, refused.body.code]).toEqual([
      422,
      'FILE_CONTENT_MISMATCH',
    ]);
    // Types and sizes the purpose refuses never start.
    const text = await post('uploads', {
      token,
      kind: 'other_proof',
      contentType: 'text/plain',
      size: 10,
    });
    expect(text.status).toBe(400);
    expect(text.body.fields?.[0].code).toBe('FILE_TYPE_NOT_ALLOWED');
    const big = await post('uploads', {
      token,
      kind: 'other_proof',
      contentType: 'application/pdf',
      size: 10 * 1024 * 1024 + 1,
    });
    expect(big.status).toBe(400);
    expect(big.body.fields?.[0].code).toBe('FILE_TOO_LARGE');

    // Live uploads count: two more pending ones reach the limit.
    expect((await upload(token)).status).toBe(201);
    const third = await upload(token);
    expect(third.status).toBe(201);
    const fourth = await upload(token);
    expect([fourth.status, fourth.body.code]).toEqual([
      409,
      'REGISTRATION_DOCUMENT_LIMIT',
    ]);
    const removed = await post(`documents/${third.body.document!.id}/remove`, {
      token,
    });
    expect(removed.status).toBe(204);
    expect((await upload(token)).status).toBe(201);

    // The manager sees the documents and reads a ready one (no-store).
    const [p] = (await x.asManager(c, () => reg.pending())).items.filter(
      (q) => q.id === id,
    );
    expect(p.documents.map((d) => [d.id, d.ready])).toContainEqual([
      first,
      true,
    ]);
    const read = await x.asManager(c, () => reg.documentUrl(id, first));
    expect(read.document).toMatchObject({ id: first, ready: true });
    expect(read.read.url).toMatch(/^http/);
    // Another request's document is not this one's.
    const other = await register(c, request(linkToken, 'D-3'));
    const otherToken = await tokenOf(c, other);
    const cross = await post(`documents/${first}/remove`, {
      token: otherToken,
    });
    expect([cross.status, cross.body.code]).toEqual([
      404,
      'REGISTRATION_DOCUMENT_NOT_FOUND',
    ]);

    const audit = await auditReaders(h).tenant(c.tenantId, {
      action: 'resident.registration_document_added',
      targetId: id,
    });
    expect(audit[0]).toMatchObject({ actorType: 'system', actorId: null });
    expect(JSON.stringify(audit)).not.toMatch(/Registrant|@/);
  });

  it('a correction: codes by email with a new link, the old one dead; resubmit needs a ready document', async () => {
    const { c, linkToken } = await compound();
    const id = await register(c, request(linkToken, 'D-4'));
    const first = await tokenOf(c, id);
    await x.asManager(c, () =>
      reg.requestCorrection(id, {
        codes: ['document_missing', 'document_missing'],
      }),
    );
    await expect(
      x.asManager(c, () =>
        reg.requestCorrection(id, { codes: ['document_unreadable'] }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'REGISTRATION_CORRECTION_PENDING' },
    });
    await expect(
      x.asManager(c, () => reg.requestCorrection(id, { codes: ['rude'] })),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_FAILED' } });

    expect(await row(c, id)).toMatchObject({
      status: 'needs_correction',
      correctionCodes: ['document_missing'],
      statusLinkSeq: 2,
    });
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'community.registration_correction',
      },
    });
    expect(mail.params).toMatchObject({
      registrationId: id,
      seq: 2,
      codes: ['document_missing'],
    });
    expect((await post('status', { token: first })).status).toBe(404);
    const token = await tokenOf(c, id);
    expect((await post('status', { token })).body).toMatchObject({
      status: 'needs_correction',
      correctionCodes: ['document_missing'],
    });

    const early = await post('resubmit', { token });
    expect([early.status, early.body.code]).toEqual([
      409,
      'REGISTRATION_DOCUMENTS_REQUIRED',
    ]);
    // A pending upload is not enough: it must be finalized.
    await upload(token);
    expect((await post('resubmit', { token })).body.code).toBe(
      'REGISTRATION_DOCUMENTS_REQUIRED',
    );
    await readyDocument(token);
    const back = await post('resubmit', { token });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'pending', correctionCodes: [] });
    const twice = await post('resubmit', { token });
    expect(twice.body.code).toBe('REGISTRATION_NOT_AWAITING_CORRECTION');
    expect((await row(c, id)).resubmittedAt).not.toBeNull();
  });

  it('registering again with the same email answers a correction: pending, new link, documents kept', async () => {
    const { c, linkToken } = await compound();
    const r = request(linkToken, 'D-5');
    const id = await register(c, r);
    await readyDocument(await tokenOf(c, id));
    await x.asManager(c, () =>
      reg.requestCorrection(id, { codes: ['details_mismatch'] }),
    );
    const sent = await tokenOf(c, id);
    const fixed = { ...r, fullName: `Corrected ${uniqueSuffix()}` };
    expect(await register(c, fixed)).toBe(id);
    expect(await row(c, id)).toMatchObject({
      status: 'pending',
      correctionCodes: [],
      fullName: fixed.fullName,
      statusLinkSeq: 3,
    });
    expect((await post('status', { token: sent })).status).toBe(404);
    expect(
      (await post('status', { token: await tokenOf(c, id) })).body.documents,
    ).toHaveLength(1);
  });

  it('the decision kills the link and deletes the documents: approve, reject, expire', async () => {
    const { c, linkToken } = await compound();
    const outcomes: [string, string][] = [];
    for (const how of ['approve', 'reject', 'expire'] as const) {
      const u = await x.unit(c);
      const id = await register(c, request(linkToken, u.code));
      const token = await tokenOf(c, id);
      await readyDocument(token);
      if (how === 'approve') await x.asManager(c, () => reg.approve(id));
      if (how === 'reject')
        await x.asManager(c, () =>
          reg.reject(id, { code: 'documents_missing', text: 'Unreadable' }),
        );
      if (how === 'expire') {
        await x.asManager(c, () =>
          reg.requestCorrection(id, { codes: ['document_unreadable'] }),
        );
        // The correction restarts the clock; past it, the request expires.
        await h.moduleRef
          .get(SweepRunner)
          .run(REGISTRATION_EXPIRY_SWEEP, daysLater(31));
      }
      outcomes.push([how, (await row(c, id)).status]);
      expect(
        (await post('status', { token: await tokenOf(c, id) })).status,
      ).toBe(404);
      expect(
        await globalDb.registrationStatusLink.count({
          where: { registrationId: id },
        }),
      ).toBe(0);
      expect(await liveFiles(c, id)).toBe(0);
    }
    expect(outcomes).toEqual([
      ['approve', 'approved'],
      ['reject', 'rejected'],
      ['expire', 'expired'],
    ]);
  });

  it('the expiry counts from the latest correction or resubmission', async () => {
    const { c, linkToken } = await compound();
    const id = await register(c, request(linkToken, 'D-6'));
    // Asked later than created: a sweep 29 days on keeps it.
    await x.asManager(c, () =>
      reg.requestCorrection(id, { codes: ['document_missing'] }),
    );
    await h.moduleRef
      .get(SweepRunner)
      .run(REGISTRATION_EXPIRY_SWEEP, daysLater(29));
    expect((await row(c, id)).status).toBe('needs_correction');
  });

  it('rate-limited per link before anything is read', async () => {
    const { c, linkToken } = await compound();
    const id = await register(c, request(linkToken, 'D-7'));
    const token = await tokenOf(c, id);
    let last = 0;
    // The per-link limit is real in tests (20 a minute, test-env.ts).
    for (let i = 0; i <= 20; i++)
      last = (await post('status', { token }, `10.9.${i}.1`)).status;
    expect(last).toBe(429);
  });

  it('race: an upload against the decision never leaves a live document on a decided request', async () => {
    const { c, linkToken } = await compound();
    for (let i = 0; i < 4; i++) {
      const u = await x.unit(c);
      const id = await register(c, request(linkToken, u.code));
      const token = await tokenOf(c, id);
      const [up] = await Promise.all([
        upload(token),
        x.asManager(c, () => reg.approve(id)),
      ]);
      expect([201, 404]).toContain(up.status);
      expect(await liveFiles(c, id)).toBe(0);
    }
  });

  const links = (id: string) =>
    globalDb.registrationStatusLink.count({ where: { registrationId: id } });

  it('race: a correction against the approval — approved, its link dead', async () => {
    const { c, linkToken } = await compound();
    for (let i = 0; i < 4; i++) {
      const u = await x.unit(c);
      const id = await register(c, request(linkToken, u.code));
      const [corrected, approved] = await Promise.allSettled([
        x.asManager(c, () =>
          reg.requestCorrection(id, { codes: ['document_missing'] }),
        ),
        x.asManager(c, () => reg.approve(id)),
      ]);
      // The approval takes a request sent back too: it always ends
      // approved. A correction that came first issued a link the approval
      // then killed; one that came second found the request decided.
      expect(approved.status).toBe('fulfilled');
      expect((await row(c, id)).status).toBe('approved');
      expect(await links(id)).toBe(0);
      if (corrected.status === 'rejected')
        expect(String(corrected.reason)).toMatch(/not found|decided/i);
    }
  });

  it('race: a resubmission against the expiry sweep — expired, the link dead, no file left', async () => {
    const { c, linkToken } = await compound();
    const sweep = h.moduleRef.get(SweepRunner);
    for (let i = 0; i < 4; i++) {
      const id = await register(c, request(linkToken, `D-X${i}`));
      await x.asManager(c, () =>
        reg.requestCorrection(id, { codes: ['document_missing'] }),
      );
      const token = await tokenOf(c, id);
      await readyDocument(token);
      // 31 days on, even a resubmission made now is past the 30.
      const [sent] = await Promise.all([
        post('resubmit', { token }),
        sweep.run(REGISTRATION_EXPIRY_SWEEP, daysLater(31)),
      ]);
      expect([200, 404]).toContain(sent.status);
      expect((await row(c, id)).status).toBe('expired');
      expect(await links(id)).toBe(0);
      expect(await liveFiles(c, id)).toBe(0);
    }
  });

  it('race: a resubmission against a rejection ends rejected with the link dead', async () => {
    const { c, linkToken } = await compound();
    for (let i = 0; i < 4; i++) {
      const id = await register(c, request(linkToken, `D-R${i}`));
      await readyDocument(await tokenOf(c, id));
      await x.asManager(c, () =>
        reg.requestCorrection(id, { codes: ['document_missing'] }),
      );
      const token = await tokenOf(c, id);
      await readyDocument(token);
      const [sent] = await Promise.all([
        post('resubmit', { token }),
        x.asManager(c, () =>
          reg.reject(id, { code: 'other', text: 'Not a resident' }),
        ),
      ]);
      expect([200, 404]).toContain(sent.status);
      expect((await row(c, id)).status).toBe('rejected');
      expect(await liveFiles(c, id)).toBe(0);
      expect((await post('status', { token })).status).toBe(404);
    }
  });
});
