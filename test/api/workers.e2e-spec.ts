import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

const CODE = ['accessCode', 'engagementId'];
const SCHEDULE = [
  'schedule',
  'schedule.days',
  'schedule.windows',
  'schedule.windows[].from',
  'schedule.windows[].to',
];

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
    expect(resumed.body).toEqual({ engagementId, accessCode: null });

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
    expect(keyPaths(incident.body)).toEqual([
      'accessCode',
      'engagementId',
      'incidentId',
    ]);
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
    expect(rejected.body).toEqual({ engagementId, accessCode: null });
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
});
