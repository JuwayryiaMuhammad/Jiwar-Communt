import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { UNCONFIRMED_EXITS_SWEEP } from '../../src/gate/entries/entries.service';
import { GateSubjects } from '../../src/gate/entries/subjects';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
import { newId } from '../../src/core/common/uuid';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { passBody } from './routes/visitors';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

const VERIFY = [
  'display',
  'display.capacity',
  // A valid resident (ADR 0031); null for visitors and workers.
  'display.firstName',
  'display.partySize',
  'display.passKind',
  // Null but for a valid worker with a photo (ADR 0029).
  'display.photo',
  'display.photoUrl',
  'display.unitCode',
  'display.unitCodes',
  'display.workerName',
  'next',
  'reason',
  'result',
  'subject',
  'subjectId',
];
const ENTRY = [
  'direction',
  'id',
  'method',
  'occurredAt',
  'recordedAt',
  'subjectId',
  'subjectType',
  'unitCode',
];
const INSIDE = [
  'enteredAt',
  'gateName',
  'kind',
  'partySize',
  'subjectId',
  'subjectType',
  'unitCode',
];

/** The compound's local weekday (Africa/Cairo, the default). */
function cairoWeekday(at = new Date()): number {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    weekday: 'short',
  }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
}
/** Every day, all but one minute (an overnight window). */
const ALWAYS = {
  days: [0, 1, 2, 3, 4, 5, 6],
  windows: [{ from: '05:00', to: '04:59' }],
};

describe('API v0 — verify, entries, inside (ADR 0028)', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const guard = () => w.a.tokens.guard;
  const status = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });
  const verify = (code: string, token = guard()) =>
    call(w, 'POST', '/gate/verify', { token, body: { code } });
  const record = (body: object, token = guard()) =>
    call(w, 'POST', '/gate/entries', { token, body });
  const newPass = async (over: object = {}) => {
    const res = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/visitor-passes`,
      {
        token: w.a.tokens.owner,
        body: passBody(over),
      },
    ).expect(201);
    return res.body as { id: string; code: string };
  };

  /** A worker of a fresh unit, approved, with its code. */
  async function worker(schedule: object = ALWAYS, capacity = 'hourly') {
    const unit = await w.helpers.unit(w.a);
    const resident = await w.helpers.resident(w.a, [unit.id]);
    const token = await w.tokenFor(w.a, resident.id, 'resident');
    const registered = await call(w, 'POST', `/units/${unit.id}/workers`, {
      token,
      body: (() => {
        const { schedule: base, ...rest } = workerBody();
        void base;
        return {
          ...rest,
          capacity,
          ...(capacity === 'live_in' ? {} : { schedule }),
        };
      })(),
    }).expect(201);
    const engagementId = (registered.body as { engagementId: string })
      .engagementId;
    const approved = await call(
      w,
      'POST',
      `/worker-engagements/${engagementId}/review`,
      { token: w.a.tokens.manager, body: { decision: 'approve' } },
    ).expect(200);
    return {
      engagementId,
      unitId: unit.id,
      token,
      code: (approved.body as { accessCode: string }).accessCode,
    };
  }

  it('a one-time pass: verify, in, inside, out — then the code is gone', async () => {
    const pass = await newPass({ visitorName: 'Inside Guest', partySize: 3 });
    const checked = await verify(pass.code).expect(200);
    expect(keyPaths(checked.body)).toEqual(VERIFY);
    expect(checked.body).toEqual({
      result: 'valid',
      subject: 'visitor',
      reason: null,
      subjectId: pass.id,
      next: 'in',
      display: {
        unitCode: expect.any(String) as string,
        passKind: 'one_time',
        partySize: 3,
        workerName: null,
        capacity: null,
        photo: null,
        // A resident's alone (ADR 0031).
        firstName: null,
        unitCodes: null,
        photoUrl: null,
      },
    });
    const entered = await record({
      subjectType: 'visitor_pass',
      subjectId: pass.id,
      direction: 'in',
    }).expect(201);
    expect(keyPaths(entered.body)).toEqual(ENTRY);
    expect(entered.body).toMatchObject({ method: 'code', direction: 'in' });

    // Used: the code no longer opens anything.
    expect((await verify(pass.code).expect(200)).body).toMatchObject({
      result: 'invalid',
      reason: 'unknown_code',
    });
    const again = await record({
      subjectType: 'visitor_pass',
      subjectId: pass.id,
      direction: 'in',
    });
    expect(status(again)).toEqual({ status: 409, code: 'ALREADY_INSIDE' });

    const inside = await call(w, 'GET', '/gate/inside', {
      token: guard(),
      query: { limit: '100' },
    }).expect(200);
    expect(keyPaths(inside.body)).toEqual(listKeys(INSIDE));
    expect(JSON.stringify(inside.body)).not.toContain('Inside Guest');
    const mine = (inside.body as { data: { subjectId: string }[] }).data.find(
      (i) => i.subjectId === pass.id,
    );
    expect(mine).toMatchObject({
      subjectType: 'visitor_pass',
      kind: 'one_time',
      partySize: 3,
      gateName: w.a.gateName,
    });

    await record({
      subjectType: 'visitor_pass',
      subjectId: pass.id,
      direction: 'out',
    }).expect(201);
    const after = await call(w, 'GET', '/gate/inside', {
      token: guard(),
      query: { limit: '100' },
    }).expect(200);
    expect(JSON.stringify(after.body)).not.toContain(pass.id);
    const twice = await record({
      subjectType: 'visitor_pass',
      subjectId: pass.id,
      direction: 'out',
    });
    expect(status(twice)).toEqual({ status: 409, code: 'NOT_INSIDE' });
  });

  it('an unknown code and another compound’s code get the same answer', async () => {
    const theirs = await w.helpers.as(
      w.b,
      { id: w.b.ids.owner, type: 'resident' },
      () =>
        h.moduleRef.get(VisitorPassesService).create(w.b.homeUnitId, {
          kind: 'one_time',
          partySize: 1,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 3_600_000),
        }),
    );
    const bodies = await Promise.all(
      [theirs.code!, '000000', '12345678', 'abc'].map(async (code) =>
        JSON.stringify((await verify(code).expect(200)).body),
      ),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({
      result: 'invalid',
      subject: null,
      reason: 'unknown_code',
      subjectId: null,
      next: null,
      display: null,
    });
  });

  it('every refusal of a pass', async () => {
    const future = await newPass({
      validFrom: new Date(Date.now() + 3_600_000).toISOString(),
      validUntil: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect((await verify(future.code).expect(200)).body).toMatchObject({
      result: 'invalid',
      reason: 'not_yet_valid',
      subjectId: null,
      display: { passKind: 'one_time' },
    });
    // The host leaves: their pass stops working at once.
    const unit = await w.helpers.unit(w.a);
    const host = await w.helpers.resident(w.a, [unit.id], 'tenant');
    const hostToken = await w.tokenFor(w.a, host.id, 'resident');
    const hosted = (
      await call(w, 'POST', `/units/${unit.id}/visitor-passes`, {
        token: hostToken,
        body: passBody(),
      }).expect(201)
    ).body as { code: string };
    const [occupancy] = await w.helpers.occupancies(w.a, unit.id);
    await w.helpers.asManager(w.a, () =>
      w.helpers.residents.endOccupancy(occupancy.id, {
        code: 'moved_out',
        text: 'Left',
      }),
    );
    expect((await verify(hosted.code).expect(200)).body).toMatchObject({
      reason: 'host_inactive',
    });
  });

  it('a recurring overnight pass is read in the compound’s own time zone', async () => {
    const pass = await newPass({
      kind: 'recurring',
      validUntil: new Date(Date.now() + 179 * 86_400_000).toISOString(),
      // Thursday 22:00 → Friday 02:00, local time.
      schedule: { days: [4], windows: [{ from: '22:00', to: '02:00' }] },
    });
    const subjects = h.moduleRef.get(GateSubjects);
    const at = async (iso: string, tz: string) =>
      w.helpers.asManager(w.a, () =>
        h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
          const row = await tx.visitorPass.findUniqueOrThrow({
            where: { id: pass.id },
          });
          return subjects.refusal(
            tx,
            await subjects.pass(tx, row),
            new Date(iso),
            tz,
          );
        }),
      );
    // Thursday 2026-12-03 (Cairo UTC+2, Riyadh UTC+3).
    expect(await at('2026-12-03T20:30:00Z', 'Asia/Riyadh')).toBeNull(); // Thu 23:30
    expect(await at('2026-12-03T22:30:00Z', 'Asia/Riyadh')).toBeNull(); // Fri 01:30
    expect(await at('2026-12-03T23:30:00Z', 'Asia/Riyadh')).toBe(
      'outside_schedule',
    ); // Fri 02:30
    expect(await at('2026-12-03T23:30:00Z', 'Africa/Cairo')).toBeNull(); // Fri 01:30
    expect(await at('2026-12-04T00:30:00Z', 'Africa/Cairo')).toBe(
      'outside_schedule',
    ); // Fri 02:30
    expect(await at('2026-12-03T19:30:00Z', 'Africa/Cairo')).toBe(
      'outside_schedule',
    ); // Thu 21:30
  });

  it('workers: in schedule, suspended, banned, off schedule', async () => {
    const ok = await worker();
    const res = await verify(ok.code).expect(200);
    expect(res.body).toMatchObject({
      result: 'valid',
      subject: 'worker',
      subjectId: ok.engagementId,
      next: 'in',
      display: {
        workerName: 'Api Worker',
        capacity: 'hourly',
        passKind: null,
        partySize: null,
      },
    });
    await record({
      subjectType: 'worker_engagement',
      subjectId: ok.engagementId,
      direction: 'in',
    }).expect(201);
    expect((await verify(ok.code).expect(200)).body).toMatchObject({
      result: 'valid',
      next: 'out',
    });

    const suspended = await worker();
    await call(
      w,
      'POST',
      `/worker-engagements/${suspended.engagementId}/suspend`,
      {
        token: suspended.token,
        body: { reasonCode: 'leave', reason: 'Holiday' },
      },
    ).expect(204);
    expect((await verify(suspended.code).expect(200)).body).toMatchObject({
      result: 'invalid',
      reason: 'suspended',
      subjectId: null,
    });

    const banned = await worker();
    const detail = await call(
      w,
      'GET',
      `/worker-engagements/${banned.engagementId}`,
      { token: w.a.tokens.manager },
    ).expect(200);
    await call(
      w,
      'POST',
      `/workers/${(detail.body as { worker: { id: string } }).worker.id}/ban`,
      {
        token: w.a.tokens.manager,
        body: { reasonCode: 'security', reason: 'Incident' },
      },
    ).expect(204);
    expect((await verify(banned.code).expect(200)).body).toMatchObject({
      reason: expect.stringMatching(
        /^(banned|suspended|unknown_code)$/,
      ) as string,
      result: 'invalid',
    });

    const day = (cairoWeekday() + 3) % 7;
    const off = await worker({
      days: [day],
      windows: [{ from: '03:00', to: '03:01' }],
    });
    expect((await verify(off.code).expect(200)).body).toMatchObject({
      result: 'invalid',
      reason: 'outside_schedule',
      subjectId: off.engagementId,
      next: null,
    });
    const refused = await record({
      subjectType: 'worker_engagement',
      subjectId: off.engagementId,
      direction: 'in',
    });
    expect(status(refused)).toEqual({
      status: 409,
      code: 'GATE_ENTRY_REFUSED',
    });
    expect(err(refused).params).toEqual({ reason: 'outside_schedule' });
  });

  it('entries: backdating within 24 h, checked at that moment; client ids', async () => {
    const pass = await newPass();
    const tooOld = await record({
      subjectType: 'visitor_pass',
      subjectId: pass.id,
      direction: 'in',
      occurredAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    });
    expect(err(tooOld).fields).toEqual([
      {
        field: 'occurredAt',
        code: 'INVALID_VALUE',
        params: { maxHoursBack: 24, maxMinutesAhead: 5 },
      },
    ]);
    // Before the pass started: refused, though it is valid now.
    const early = await record({
      subjectType: 'visitor_pass',
      subjectId: pass.id,
      direction: 'in',
      occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(err(early)).toMatchObject({
      code: 'GATE_ENTRY_REFUSED',
      params: { reason: 'not_yet_valid' },
    });

    const id = newId();
    const body = {
      id,
      subjectType: 'visitor_pass',
      subjectId: pass.id,
      direction: 'in',
    };
    const first = await record(body).expect(201);
    const retry = await record(body).expect(201);
    expect(retry.body).toEqual(first.body);
    const clash = await record({ ...body, direction: 'out' });
    expect(status(clash)).toEqual({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const rows = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.gateEntry.count({
        where: { subjectId: pass.id },
      }),
    );
    expect(rows).toBe(1);
  });

  it('Idempotency-Key on entries: one entry, one answer', async () => {
    const pass = await newPass();
    const send = () =>
      w.h
        .http()
        .post('/api/v1/gate/entries')
        .set('Authorization', `Bearer ${guard()}`)
        .set('Idempotency-Key', `entry-${pass.id}`)
        .send({
          subjectType: 'visitor_pass',
          subjectId: pass.id,
          direction: 'in',
        });
    const [x, y] = await Promise.all([send(), send()]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body).toEqual(y.body);
    const rows = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.gateEntry.count({
        where: { subjectId: pass.id },
      }),
    );
    expect(rows).toBe(1);
  });

  it('a guard off duty can do nothing at the gate; the manager reads the log', async () => {
    const off = await gateHelpers(h).guard(w.a);
    const token = await w.tokenFor(w.a, off.id, 'staff');
    for (const res of [
      await verify('123456', token),
      await record(
        { subjectType: 'visitor_pass', subjectId: newId(), direction: 'in' },
        token,
      ),
      await call(w, 'GET', '/gate/inside', { token }),
    ])
      expect(status(res)).toEqual({ status: 403, code: 'NO_OPEN_SHIFT' });

    const log = await call(w, 'GET', '/gate/entries', {
      token: w.a.tokens.manager,
      query: { gateId: w.a.gateId, direction: 'in' },
    }).expect(200);
    expect(keyPaths(log.body)).toEqual(
      listKeys(
        [
          ...ENTRY,
          'gateId',
          'guard',
          'guard.fullName',
          'guard.id',
          'shiftId',
          'unconfirmed',
          'unitId',
        ].sort(),
      ),
    );
    const data = (log.body as { data: { guard: { id: string } }[] }).data;
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((e) => e.guard.id === w.a.ids.guard)).toBe(true);
  });

  it('verify is rate-limited per guard', async () => {
    const g = await gateHelpers(h).guard(w.a);
    await gateHelpers(h).startShift(w.a, g.id, w.a.gateId);
    const token = await w.tokenFor(w.a, g.id, 'staff');
    for (let i = 0; i < 30; i++) await verify('000000', token).expect(200);
    expect(status(await verify('000000', token))).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
    });
    // Another guard is not affected.
    await verify('000000').expect(200);
  });

  it('the unconfirmed-exit sweep closes stale entries, never a live-in worker', async () => {
    const pass = await newPass();
    await record({
      subjectType: 'visitor_pass',
      subjectId: pass.id,
      direction: 'in',
    }).expect(201);
    const liveIn = await worker(undefined, 'live_in');
    await record({
      subjectType: 'worker_engagement',
      subjectId: liveIn.engagementId,
      direction: 'in',
    }).expect(201);
    const sweep = h.moduleRef.get(SweepRunner);
    await sweep.run(UNCONFIRMED_EXITS_SWEEP, new Date(Date.now() + 3_600_000));
    const entries = (subjectId: string) =>
      w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.gateEntry.findMany({
          where: { subjectId },
          orderBy: { occurredAt: 'asc' },
        }),
      );
    expect(await entries(pass.id)).toHaveLength(1);
    const later = new Date(Date.now() + 13 * 3_600_000);
    await sweep.run(UNCONFIRMED_EXITS_SWEEP, later);
    await sweep.run(UNCONFIRMED_EXITS_SWEEP, later); // idempotent
    const closed = await entries(pass.id);
    expect(closed).toHaveLength(2);
    expect(closed[1]).toMatchObject({
      direction: 'out',
      method: 'system',
      unconfirmed: true,
      guardAccountId: null,
      shiftId: null,
    });
    expect(await entries(liveIn.engagementId)).toHaveLength(1);
    const log = await call(w, 'GET', '/gate/entries', {
      token: w.a.tokens.manager,
      query: { direction: 'out', limit: '100' },
    }).expect(200);
    const system = (
      log.body as {
        data: { subjectId: string; guard: null; unconfirmed: boolean }[];
      }
    ).data.find((e) => e.subjectId === pass.id);
    expect(system).toMatchObject({ guard: null, unconfirmed: true });
  });
});
