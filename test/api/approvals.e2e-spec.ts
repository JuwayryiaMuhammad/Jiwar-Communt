import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { REQUEST_TIMEOUTS_SWEEP } from '../../src/gate/approvals/approvals.service';
import { VISITOR_DATA_SWEEP } from '../../src/gate/visitors/visitor-data.sweep';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

const GUARD_VIEW = [
  'createdAt',
  'decisionSource',
  'expiresAt',
  'id',
  'kind',
  'partySize',
  'status',
  'unitCode',
];
const HOST_VIEW = [
  'createdAt',
  'expiresAt',
  'gateName',
  'id',
  'kind',
  'partySize',
  'unitCode',
  'unitId',
  'visitorName',
  'workerName',
];

describe('API v0 — approvals at the gate (ADR 0028)', () => {
  let h: HttpHarness;
  let w: World;
  let homeCode: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    homeCode = (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.homeUnitId },
        }),
      )
    ).code;
  }, 120_000);

  afterAll(() => h.close());

  const guard = () => w.a.tokens.guard;
  const status = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });
  const ask = (body: object = {}) =>
    call(w, 'POST', '/gate/approval-requests', {
      token: guard(),
      body: { kind: 'uninvited_visitor', unitCode: homeCode, ...body },
    });
  const askId = async (body: object = {}) =>
    ((await ask(body).expect(201)).body as { id: string }).id;
  const decide = (id: string, token: string, decision: string) =>
    call(w, 'POST', `/gate-requests/${id}/decide`, {
      token,
      body: { decision },
    });
  const guardView = async (id: string) =>
    (
      await call(w, 'GET', `/gate/approval-requests/${id}`, {
        token: guard(),
      }).expect(200)
    ).body as { status: string; decisionSource: string | null };
  const notified = (targetId: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.notification.findMany({
        where: { targetId },
        orderBy: { accountId: 'asc' },
      }),
    );
  /** Moves a pending request past its time, as if nobody answered. */
  const expire = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.gateApprovalRequest.update({
        where: { id },
        data: {
          createdAt: new Date(Date.now() - 10 * 60_000),
          expiresAt: new Date(Date.now() - 60_000),
        },
      }),
    );

  it('the guard asks; exactly the people who may invite are told, critically', async () => {
    const res = await ask({ partySize: 2, visitorName: 'Gate Guest' }).expect(
      201,
    );
    expect(keyPaths(res.body)).toEqual(GUARD_VIEW);
    expect(res.body).toMatchObject({
      kind: 'uninvited_visitor',
      unitCode: homeCode,
      partySize: 2,
      status: 'pending',
      decisionSource: null,
    });
    const id = (res.body as { id: string }).id;
    const rows = await notified(id);
    expect(rows.map((n) => n.accountId).sort()).toEqual(
      [w.a.ids.owner, w.a.ids.family].sort(),
    );
    expect(rows[0]).toMatchObject({
      kind: 'gate.approval_requested',
      priority: 'critical',
      params: {
        unitCode: homeCode,
        requestKind: 'uninvited_visitor',
        partySize: 2,
        gateName: w.a.gateName,
        visitorName: 'Gate Guest',
      },
    });

    const mine = await call(w, 'GET', '/me/gate-requests', {
      token: w.a.tokens.owner,
    }).expect(200);
    expect(keyPaths(mine.body)).toEqual(listKeys(HOST_VIEW));
    expect(
      (mine.body as { data: { id: string; visitorName: string }[] }).data.find(
        (r) => r.id === id,
      ),
    ).toMatchObject({ visitorName: 'Gate Guest', gateName: w.a.gateName });
    // Not the tenant of another unit, not the landlord.
    for (const token of [w.a.tokens.tenant, w.a.tokens.landlord]) {
      const other = await call(w, 'GET', '/me/gate-requests', {
        token,
      }).expect(200);
      expect(JSON.stringify(other.body)).not.toContain(id);
      expect(status(await decide(id, token, 'approve'))).toEqual({
        status: 404,
        code: 'GATE_REQUEST_NOT_FOUND',
      });
    }
    // The guard never sees who is told or who decides.
    expect(JSON.stringify(res.body)).not.toContain(w.a.ids.owner);
  });

  it('the first decision wins under concurrency', async () => {
    const id = await askId();
    const [x, y] = await Promise.all([
      decide(id, w.a.tokens.owner, 'approve'),
      decide(id, w.a.tokens.family, 'approve'),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const lost = x.status === 409 ? x : y;
    expect(err(lost)).toMatchObject({
      code: 'GATE_REQUEST_DECIDED',
      params: { status: 'approved' },
    });
    expect(await guardView(id)).toMatchObject({
      status: 'approved',
      decisionSource: 'household',
    });
  });

  it('deny wins over an approval until the entry, and the guard is told', async () => {
    const id = await askId();
    await decide(id, w.a.tokens.owner, 'approve').expect(200);
    const reversed = await decide(id, w.a.tokens.family, 'deny').expect(200);
    expect(reversed.body).toEqual({
      id,
      status: 'denied',
      decisionSource: 'household',
    });
    const told = (await notified(id)).filter(
      (n) => n.kind === 'gate.approval_reversed',
    );
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      accountId: w.a.ids.guard,
      priority: 'critical',
    });
    const entry = await call(w, 'POST', '/gate/entries', {
      token: guard(),
      body: { subjectType: 'gate_request', subjectId: id, direction: 'in' },
    });
    expect(err(entry)).toMatchObject({
      code: 'GATE_ENTRY_REFUSED',
      params: { reason: 'not_approved' },
    });

    // Once they came in, a deny is too late.
    const second = await askId();
    await decide(second, w.a.tokens.owner, 'approve').expect(200);
    const inside = await call(w, 'POST', '/gate/entries', {
      token: guard(),
      body: { subjectType: 'gate_request', subjectId: second, direction: 'in' },
    }).expect(201);
    expect(inside.body).toMatchObject({
      method: 'approval',
      subjectType: 'gate_request',
      subjectId: second,
    });
    expect(status(await decide(second, w.a.tokens.family, 'deny'))).toEqual({
      status: 409,
      code: 'GATE_REQUEST_DECIDED',
    });
    // An approval lets in once.
    await call(w, 'POST', '/gate/entries', {
      token: guard(),
      body: {
        subjectType: 'gate_request',
        subjectId: second,
        direction: 'out',
      },
    }).expect(201);
    const again = await call(w, 'POST', '/gate/entries', {
      token: guard(),
      body: { subjectType: 'gate_request', subjectId: second, direction: 'in' },
    });
    expect(err(again).params).toEqual({ reason: 'used' });
  });

  it('nobody answers: the standing instruction applies, lazily and by the sweep', async () => {
    const unit = await w.helpers.unit(w.a);
    const primary = await w.helpers.resident(w.a, [unit.id]);
    const token = await w.tokenFor(w.a, primary.id, 'resident');
    const code = (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: unit.id },
        }),
      )
    ).code;
    const set = (uninvitedVisitor: string, delivery: string) =>
      call(w, 'PUT', `/units/${unit.id}/gate-instructions`, {
        token,
        body: { uninvitedVisitor, delivery },
      }).expect(200);
    const timedOut = async (kind: string) => {
      const id = await askId({ kind, unitCode: code });
      await expire(id);
      return guardView(id);
    };
    expect(await timedOut('uninvited_visitor')).toEqual(
      expect.objectContaining({
        status: 'timed_out',
        decisionSource: 'timeout',
      }),
    );
    await set('allow', 'leave_at_gate');
    expect(await timedOut('uninvited_visitor')).toEqual(
      expect.objectContaining({
        status: 'approved',
        decisionSource: 'standing_instruction',
      }),
    );
    expect(await timedOut('delivery')).toEqual(
      expect.objectContaining({
        status: 'leave_at_gate',
        decisionSource: 'standing_instruction',
      }),
    );
    await set('deny', 'deny');
    expect(await timedOut('uninvited_visitor')).toEqual(
      expect.objectContaining({
        status: 'denied',
        decisionSource: 'standing_instruction',
      }),
    );
    // A late answer loses to the timeout.
    const late = await askId({ unitCode: code });
    await expire(late);
    expect(err(await decide(late, token, 'approve'))).toMatchObject({
      code: 'GATE_REQUEST_DECIDED',
      params: { status: 'denied' },
    });
    // The sweep, with no reader at all.
    const swept = await askId({ kind: 'delivery', unitCode: code });
    await expire(swept);
    await h.moduleRef.get(SweepRunner).run(REQUEST_TIMEOUTS_SWEEP, new Date());
    const row = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.gateApprovalRequest.findUniqueOrThrow({
        where: { id: swept },
      }),
    );
    expect(row).toMatchObject({
      status: 'denied',
      decisionSource: 'standing_instruction',
      decidedById: null,
    });
  });

  it('the guard withdraws a pending request', async () => {
    const id = await askId();
    const res = await call(
      w,
      'POST',
      `/gate/approval-requests/${id}/withdraw`,
      { token: guard() },
    ).expect(200);
    expect(res.body).toMatchObject({
      status: 'withdrawn',
      decisionSource: 'guard',
    });
    const again = await call(
      w,
      'POST',
      `/gate/approval-requests/${id}/withdraw`,
      { token: guard() },
    );
    expect(err(again)).toMatchObject({
      code: 'GATE_REQUEST_DECIDED',
      params: { status: 'withdrawn' },
    });
    expect(status(await decide(id, w.a.tokens.owner, 'approve'))).toEqual({
      status: 409,
      code: 'GATE_REQUEST_DECIDED',
    });
  });

  it('a worker outside the schedule: ask, approve, in as the worker', async () => {
    const unit = await w.helpers.unit(w.a);
    const resident = await w.helpers.resident(w.a, [unit.id]);
    const token = await w.tokenFor(w.a, resident.id, 'resident');
    const day = (new Date().getUTCDay() + 3) % 7;
    const registered = await call(w, 'POST', `/units/${unit.id}/workers`, {
      token,
      body: {
        ...workerBody(),
        schedule: { days: [day], windows: [{ from: '03:00', to: '03:01' }] },
      },
    }).expect(201);
    const engagementId = (registered.body as { engagementId: string })
      .engagementId;
    const approved = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/review`,
      { token: w.a.tokens.manager, body: { decision: 'approve' } },
    ).expect(200);
    const code = (approved.body as { accessCode: string }).accessCode;
    const checked = await call(w, 'POST', '/gate/verify', {
      token: guard(),
      body: { code },
    }).expect(200);
    expect(checked.body).toMatchObject({
      reason: 'outside_schedule',
      subjectId: engagementId,
    });
    const asked = await call(w, 'POST', '/gate/approval-requests', {
      token: guard(),
      body: { kind: 'worker_off_schedule', engagementId },
    }).expect(201);
    const id = (asked.body as { id: string }).id;
    const host = await call(w, 'GET', '/me/gate-requests', { token }).expect(
      200,
    );
    expect(
      (host.body as { data: { id: string; workerName: string }[] }).data.find(
        (r) => r.id === id,
      ),
    ).toMatchObject({ workerName: 'Api Worker', visitorName: null });
    await decide(id, token, 'approve').expect(200);
    const entry = await call(w, 'POST', '/gate/entries', {
      token: guard(),
      body: { subjectType: 'gate_request', subjectId: id, direction: 'in' },
    }).expect(201);
    expect(entry.body).toMatchObject({
      subjectType: 'worker_engagement',
      subjectId: engagementId,
      method: 'approval',
    });
    const stored = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.gateEntry.findUniqueOrThrow({
        where: { id: (entry.body as { id: string }).id },
      }),
    );
    expect(stored.approvalRequestId).toBe(id);
    expect(
      (
        await call(w, 'POST', '/gate/verify', {
          token: guard(),
          body: { code },
        }).expect(200)
      ).body,
    ).toMatchObject({ result: 'valid', next: 'out' });

    // An approval is not needed for a worker on schedule; fields per kind.
    const missing = await call(w, 'POST', '/gate/approval-requests', {
      token: guard(),
      body: { kind: 'worker_off_schedule', unitCode: homeCode },
    });
    expect(err(missing).fields).toEqual([
      { field: 'engagementId', code: 'FIELD_REQUIRED' },
      { field: 'unitCode', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const unknownUnit = await ask({ unitCode: 'NO-SUCH-UNIT' });
    expect(status(unknownUnit)).toEqual({
      status: 404,
      code: 'UNIT_NOT_FOUND',
    });
  });

  it('the database refuses a decider without a source (the NULL trap)', async () => {
    const id = await askId();
    await expect(
      w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.gateApprovalRequest.update({
          where: { id },
          data: { decidedById: w.a.ids.owner },
        }),
      ),
    ).rejects.toThrow(/gate_approval_requests_decider_is_household/);
  });

  it('the visitor name leaves the notifications when the data expires', async () => {
    const id = await askId({ visitorName: 'Fading Guest' });
    await h.moduleRef
      .get(SweepRunner)
      .run(VISITOR_DATA_SWEEP, new Date(Date.now() + 31 * 86_400_000));
    const rows = await notified(id);
    expect(rows.length).toBeGreaterThan(0);
    for (const n of rows) {
      expect(n.params).not.toHaveProperty('visitorName');
      expect(n.params).toHaveProperty('unitCode', homeCode);
    }
    const request = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.gateApprovalRequest.findUniqueOrThrow({
        where: { id },
      }),
    );
    expect(request.visitorDetailsId).toBeNull();
  });
});
