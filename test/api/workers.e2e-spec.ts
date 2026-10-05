import { Client } from 'pg';
import { AccessTokens } from '../../src/core/auth/access-token';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

const SCHEDULE = [
  'schedule',
  'schedule.days',
  'schedule.windows',
  'schedule.windows[].from',
  'schedule.windows[].to',
];
/** The printed card's data (ADR 0030). */
const CARD = [
  'card',
  'card.capacity',
  'card.code',
  'card.compoundName',
  // Null without a photo (ADR 0029).
  'card.photo',
  'card.preferredLanguage',
  'card.qrPayload',
  ...SCHEDULE.map((k) => `card.${k}`),
  'card.securityPhone',
  'card.unitCode',
  'card.validUntil',
  'card.workerName',
];
const CODE = ['accessCode', ...CARD, 'engagementId'].sort();
const QR = /^JWR1\.([A-Za-z0-9_-]{43})$/;

describe('API v0 — workers', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;
  const owner = () => w.a.tokens.owner;

  it('register, review, codes, suspension, card incident, end', async () => {
    const body = workerBody();
    const registered = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/workers`,
      {
        token: owner(),
        body,
      },
    ).expect(201);
    expect(keyPaths(registered.body)).toEqual([
      'engagementId',
      'status',
      'warnings',
    ]);
    const { engagementId } = registered.body as { engagementId: string };

    const unitList = await call(w, 'GET', `/units/${w.a.homeUnitId}/workers`, {
      token: owner(),
    }).expect(200);
    expect(keyPaths(unitList.body)).toEqual(
      listKeys(
        [
          'capacity',
          'id',
          'monthlyWage',
          ...SCHEDULE,
          'status',
          'suspendedByManagement',
          'validUntil',
          'workerName',
        ].sort(),
      ),
    );
    expect(JSON.stringify(unitList.body)).not.toContain(body.phone);

    const review = await call(w, 'GET', '/worker-engagements', {
      token: manager(),
      query: { status: 'pending_review' },
    }).expect(200);
    expect(keyPaths(review.body)).toEqual(
      listKeys([
        'birthDateVerified',
        'capacity',
        'createdAt',
        'id',
        'idDocumentType',
        'status',
        'unitCode',
        'unitId',
        'workerId',
        'workerName',
      ]),
    );
    expect(JSON.stringify(review.body)).not.toContain(body.idDocumentNumber);

    const detail = await call(w, 'GET', `/worker-engagements/${engagementId}`, {
      token: manager(),
    }).expect(200);
    expect(keyPaths(detail.body)).toEqual(
      [
        'capacity',
        'createdAt',
        'id',
        'requestedBy',
        'requestedBy.fullName',
        'requestedBy.id',
        ...SCHEDULE,
        'status',
        'unitCode',
        'unitId',
        'validUntil',
        'worker',
        'worker.banned',
        'worker.birthDate',
        'worker.birthDateVerifiedAt',
        'worker.fullName',
        'worker.id',
        'worker.idDocumentNumberMasked',
        'worker.idDocumentType',
        'worker.nationality',
        'worker.phone',
        'worker.photo',
      ].sort(),
    );
    expect(JSON.stringify(detail.body)).not.toContain(body.idDocumentNumber);

    const approved = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/review`,
      {
        token: manager(),
        body: { decision: 'approve' },
      },
    ).expect(200);
    expect(approved.headers['cache-control']).toBe('no-store');
    expect(keyPaths(approved.body)).toEqual(CODE);
    expect(approved.body).toMatchObject({
      accessCode: expect.stringMatching(/^\d{8}$/) as string,
    });

    await call(w, 'POST', `/worker-engagements/${engagementId}/suspend`, {
      token: owner(),
      body: { reasonCode: 'leave', reason: 'Holiday' },
    }).expect(204);
    const resumed = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/resume`,
      {
        token: manager(),
      },
    ).expect(200);
    expect(resumed.headers['cache-control']).toBe('no-store');
    expect(resumed.body).toEqual({
      engagementId,
      accessCode: null,
      card: null,
    });

    const reissued = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/reissue-code`,
      {
        token: owner(),
        body: { reasonCode: 'compromised' },
      },
    ).expect(200);
    expect(reissued.headers['cache-control']).toBe('no-store');
    expect(keyPaths(reissued.body)).toEqual(CODE);

    const incident = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/card-incident`,
      {
        token: manager(),
        body: { type: 'lost', note: 'Lost at the club' },
      },
    ).expect(201);
    expect(incident.headers['cache-control']).toBe('no-store');
    expect(keyPaths(incident.body)).toEqual(
      ['accessCode', ...CARD, 'engagementId', 'incidentId'].sort(),
    );
    const incidents = await call(w, 'GET', '/card-incidents', {
      token: manager(),
      query: { status: 'open' },
    }).expect(200);
    expect(keyPaths(incidents.body)).toEqual(
      listKeys([
        'engagementId',
        'id',
        'reportedAt',
        'reportedVia',
        'status',
        'type',
        'workerId',
      ]),
    );
    expect(JSON.stringify(incidents.body)).not.toContain('Lost at the club');
    await call(
      w,
      'POST',
      `/card-incidents/${(incident.body as { incidentId: string }).incidentId}/close`,
      {
        token: manager(),
      },
    ).expect(204);

    await call(w, 'POST', `/worker-engagements/${engagementId}/end`, {
      token: owner(),
      body: { reasonCode: 'work_finished', reason: 'Done' },
    }).expect(204);
  });

  it('rejection needs a reason', async () => {
    const registered = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/workers`,
      {
        token: owner(),
        body: workerBody(),
      },
    ).expect(201);
    const { engagementId } = registered.body as { engagementId: string };
    const missing = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/review`,
      {
        token: manager(),
        body: { decision: 'reject' },
      },
    );
    expect(err(missing).code).toBe('REASON_REQUIRED');
    const rejected = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/review`,
      {
        token: manager(),
        body: {
          decision: 'reject',
          reasonCode: 'not_verified',
          reason: 'Unverified',
        },
      },
    ).expect(200);
    expect(rejected.body).toEqual({
      engagementId,
      accessCode: null,
      card: null,
    });
  });

  it('ban, birth date, compliance', async () => {
    const registered = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/workers`,
      {
        token: owner(),
        // A passport worker: a national ID carries its own birth date.
        body: {
          ...workerBody(),
          idDocumentType: 'passport',
          idDocumentNumber: `P${Date.now().toString().slice(-8)}`,
          nationality: 'PH',
          birthDate: '1988-03-04',
        },
      },
    ).expect(201);
    const detail = await call(
      w,
      'GET',
      `/worker-engagements/${(registered.body as { engagementId: string }).engagementId}`,
      { token: manager() },
    ).expect(200);
    const workerId = (detail.body as { worker: { id: string } }).worker.id;

    await call(w, 'POST', `/workers/${workerId}/ban`, {
      token: manager(),
      body: { reasonCode: 'security', reason: 'Incident' },
    }).expect(204);
    await call(w, 'POST', `/workers/${workerId}/unban`, {
      token: manager(),
    }).expect(204);
    await call(w, 'POST', `/workers/${workerId}/birth-date`, {
      token: manager(),
      body: { birthDate: '1985-05-05' },
    }).expect(204);

    const opened = await call(
      w,
      'POST',
      `/workers/${workerId}/report-underage`,
      {
        token: manager(),
        body: { reasonCode: 'report_received', reason: 'A report' },
      },
    ).expect(201);
    expect(keyPaths(opened.body)).toEqual(['caseId']);
    const cases = await call(w, 'GET', '/compliance-cases', {
      token: manager(),
      query: { status: 'open' },
    }).expect(200);
    expect(keyPaths(cases.body)).toEqual(
      listKeys([
        'closedAt',
        'id',
        'kind',
        'openedAt',
        'source',
        'status',
        'workerId',
      ]),
    );
    await call(
      w,
      'POST',
      `/compliance-cases/${(opened.body as { caseId: string }).caseId}/close`,
      {
        token: manager(),
        body: { reasonCode: 'unfounded', reason: 'Documents checked' },
      },
    ).expect(204);
  });

  // --------------------------------------------------------------------------
  // The card (ADR 0030)
  // --------------------------------------------------------------------------

  const tokens = () => h.moduleRef.get(AccessTokens);
  const hasher = () => h.moduleRef.get(IdentifierHasher);
  const engagementRow = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.workerEngagement.findUniqueOrThrow({
        where: { id },
      }),
    );
  type Card = { qrPayload: string; code: string } & Record<string, unknown>;
  const cardOf = (body: unknown) => (body as { card: Card }).card;
  const tokenOf = (body: unknown) => {
    const m = QR.exec(cardOf(body).qrPayload);
    if (!m) throw new Error('not a Jiwar QR');
    return m[1];
  };
  async function register(over: object = {}) {
    const reg = await call(w, 'POST', `/units/${w.a.homeUnitId}/workers`, {
      token: owner(),
      body: { ...workerBody(), ...over },
    }).expect(201);
    return (reg.body as { engagementId: string }).engagementId;
  }
  const approve = (id: string) =>
    call(w, 'POST', `/worker-engagements/${id}/review`, {
      token: manager(),
      body: { decision: 'approve' },
    }).expect(200);

  it('the card comes once with every new code, from one token', async () => {
    await call(w, 'PATCH', '/settings', {
      token: manager(),
      body: { emergencyPhone: '+201000000999' },
    }).expect(200);
    const id = await register({ fullName: 'Card Holder' });
    const approved = await approve(id);
    const card = cardOf(approved.body);
    const token = tokenOf(approved.body);
    const unit = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.unit.findUniqueOrThrow({
        where: { id: w.a.homeUnitId },
      }),
    );
    expect(card).toEqual({
      qrPayload: `JWR1.${token}`,
      code: tokens().codeOf(token, 8),
      workerName: 'Card Holder',
      capacity: 'hourly',
      unitCode: unit.code,
      compoundName: expect.any(String) as string,
      schedule: { days: [0, 1], windows: [{ from: '08:00', to: '12:00' }] },
      validUntil: null,
      securityPhone: '+201000000999',
      // None given at registration: the default (ADR 0030).
      preferredLanguage: 'ar',
      photo: null,
    });
    expect((approved.body as { accessCode: string }).accessCode).toBe(
      card.code,
    );
    const row = await engagementRow(id);
    expect(row.accessCodeHash).toBe(
      hasher().hashWorkerCode(w.a.tenantId, card.code),
    );
    expect(row.qrTokenHash).toBe(hasher().hashQrToken(w.a.tenantId, token));

    // Suspension keeps both; a resume with the code free brings it back, no card.
    await call(w, 'POST', `/worker-engagements/${id}/suspend`, {
      token: owner(),
      body: { reasonCode: 'leave', reason: 'Away' },
    }).expect(204);
    expect(await engagementRow(id)).toMatchObject({
      accessCodeHash: row.accessCodeHash,
      qrTokenHash: row.qrTokenHash,
    });
    const resumed = await call(w, 'POST', `/worker-engagements/${id}/resume`, {
      token: owner(),
    }).expect(200);
    expect(cardOf(resumed.body)).toBeNull();
    expect(await engagementRow(id)).toMatchObject({
      qrTokenHash: row.qrTokenHash,
    });

    // A reissue: a new token, so a new code and QR.
    const reissued = await call(
      w,
      'POST',
      `/worker-engagements/${id}/reissue-code`,
      { token: owner(), body: { reasonCode: 'lost' } },
    ).expect(200);
    const newToken = tokenOf(reissued.body);
    expect(newToken).not.toBe(token);
    expect(cardOf(reissued.body).code).toBe(tokens().codeOf(newToken, 8));
    expect((await engagementRow(id)).qrTokenHash).toBe(
      hasher().hashQrToken(w.a.tenantId, newToken),
    );

    // The card is in no GET.
    for (const path of [
      `/units/${w.a.homeUnitId}/workers`,
      `/worker-engagements/${id}`,
      '/worker-engagements',
    ]) {
      const res = await call(w, 'GET', path, {
        token: path.startsWith('/units') ? owner() : manager(),
      }).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(newToken);
      expect(JSON.stringify(res.body)).not.toContain('qrPayload');
    }

    // The end clears both.
    await call(w, 'POST', `/worker-engagements/${id}/end`, {
      token: owner(),
      body: { reasonCode: 'work_finished', reason: 'Done' },
    }).expect(204);
    expect(await engagementRow(id)).toMatchObject({
      accessCodeHash: null,
      qrTokenHash: null,
    });
    await call(w, 'PATCH', '/settings', {
      token: manager(),
      body: { emergencyPhone: null },
    }).expect(200);
  });

  it('a resume that must replace the code returns a new card', async () => {
    const first = await register();
    const firstCard = cardOf((await approve(first)).body);
    await call(w, 'POST', `/worker-engagements/${first}/suspend`, {
      token: owner(),
      body: { reasonCode: 'leave', reason: 'Away' },
    }).expect(204);
    // Another engagement takes the same code while this one is suspended.
    const second = await register();
    const spy = jest.spyOn(tokens(), 'newToken');
    try {
      spy.mockReturnValueOnce(tokenOf({ card: firstCard }));
      await approve(second);
    } finally {
      spy.mockRestore();
    }
    const resumed = await call(
      w,
      'POST',
      `/worker-engagements/${first}/resume`,
      {
        token: owner(),
      },
    ).expect(200);
    expect(resumed.headers['cache-control']).toBe('no-store');
    const card = cardOf(resumed.body);
    expect(card.code).not.toBe(firstCard.code);
    expect(card.code).toBe(tokens().codeOf(tokenOf(resumed.body), 8));
  });

  it('a derived code already in use draws a new token', async () => {
    const byCode = new Map<string, string>();
    let pair: [string, string] | null = null;
    while (!pair) {
      const t = tokens().newToken();
      const code = tokens().codeOf(t, 8);
      const seen = byCode.get(code);
      if (seen) pair = [seen, t];
      else byCode.set(code, t);
    }
    const third = tokens().newToken();
    const spy = jest.spyOn(tokens(), 'newToken');
    try {
      spy.mockReturnValueOnce(pair[0]);
      const a = await approve(await register());
      expect(tokenOf(a.body)).toBe(pair[0]);
      spy.mockReturnValueOnce(pair[1]).mockReturnValueOnce(third);
      const b = await approve(await register());
      expect(tokenOf(b.body)).toBe(third);
    } finally {
      spy.mockRestore();
    }
  });

  it('the database refuses an access code rotated without its token', async () => {
    const id = await register();
    await approve(id);
    const db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [
      w.a.tenantId,
    ]);
    try {
      await expect(
        db.query(
          `UPDATE worker_engagements SET access_code_hash = repeat('a', 64) WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('a worker access code changed without its token');
      await expect(
        db.query(
          `UPDATE worker_engagements SET status = 'ended', access_code_hash = NULL WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('worker_engagements_token_only_with_code');
    } finally {
      await db.end();
    }
  });
});
