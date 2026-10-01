import { VISITOR_DATA_SWEEP } from '../../src/gate/visitors/visitor-data.sweep';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { passBody } from './routes/visitors';
import { buildWorld, type World } from './world';

const ISSUED = [
  'code',
  'id',
  'kind',
  'partySize',
  'schedule',
  'status',
  'validFrom',
  'validUntil',
];
const LISTED = [
  'createdAt',
  'id',
  'kind',
  'mine',
  'partySize',
  'schedule',
  'status',
  'validFrom',
  'validUntil',
  'visitorName',
];
const RECURRING = {
  kind: 'recurring',
  validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  schedule: { days: [4, 5], windows: [{ from: '22:00', to: '02:00' }] },
};

describe('API v0 — visitors (ADR 0028)', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const owner = () => w.a.tokens.owner;
  const passes = (unitId = w.a.homeUnitId) => `/units/${unitId}/visitor-passes`;
  const create = (
    token: string,
    body: object,
    unitId?: string,
    key?: string,
  ) => {
    let req = w.h
      .http()
      .post(`/api/v1${passes(unitId)}`)
      .set('Authorization', `Bearer ${token}`);
    if (key) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const status = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });
  const passRow = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.visitorPass.findUniqueOrThrow({ where: { id } }),
    );

  it('a host creates a pass and sees the code once', async () => {
    const res = await create(
      owner(),
      passBody({ visitorName: 'Guest One' }),
    ).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(keyPaths(res.body)).toEqual(ISSUED);
    expect(res.body).toMatchObject({
      code: expect.stringMatching(/^\d{6}$/) as string,
      status: 'active',
      schedule: null,
    });
    const recurring = await create(owner(), passBody(RECURRING)).expect(201);
    expect(recurring.body).toMatchObject({
      kind: 'recurring',
      schedule: RECURRING.schedule,
    });
    const list = await call(w, 'GET', passes(), { token: owner() }).expect(200);
    expect(keyPaths(list.body)).toEqual(
      listKeys(
        [
          ...LISTED,
          'schedule.days',
          'schedule.windows',
          'schedule.windows[].from',
          'schedule.windows[].to',
        ].sort(),
      ),
    );
    expect(JSON.stringify(list.body)).not.toContain(
      (res.body as { code: string }).code,
    );
  });

  it('only people who may invite on the unit can', async () => {
    // A landlord who does not live there.
    const landlord = await create(
      w.a.tokens.landlord,
      passBody(),
      w.a.rentedUnitId,
    );
    expect(status(landlord)).toEqual({ status: 403, code: 'FORBIDDEN' });
    // The tenant who lives there can.
    await create(w.a.tokens.tenant, passBody(), w.a.rentedUnitId).expect(201);
    // No place in the unit at all: not found.
    const stranger = await create(
      w.a.tokens.tenant,
      passBody(),
      w.a.homeUnitId,
    );
    expect(status(stranger)).toEqual({ status: 404, code: 'UNIT_NOT_FOUND' });
    // A family member, until the primary takes visitors_invite away.
    const fresh = await w.helpers.unit(w.a);
    const primary = await w.helpers.resident(w.a, [fresh.id]);
    const member = await w.helpers.joinFamily(w.a, fresh.id, primary);
    const memberToken = await w.tokenFor(w.a, member.id, 'family');
    const primaryToken = await w.tokenFor(w.a, primary.id, 'resident');
    await create(memberToken, passBody(), fresh.id).expect(201);
    await call(
      w,
      'POST',
      `/household/members/${member.memberId}/permissions/revoke`,
      {
        token: primaryToken,
        body: {
          permission: 'visitors_invite',
          reasonCode: 'no_longer_needed',
          reason: 'Test',
        },
      },
    ).expect(204);
    const refused = await create(memberToken, passBody(), fresh.id);
    expect(status(refused)).toEqual({ status: 403, code: 'FORBIDDEN' });
  });

  it('the primary sees every pass of the unit, the visitor name only on their own', async () => {
    const fresh = await w.helpers.unit(w.a);
    const primary = await w.helpers.resident(w.a, [fresh.id]);
    const member = await w.helpers.joinFamily(w.a, fresh.id, primary);
    const memberToken = await w.tokenFor(w.a, member.id, 'family');
    const primaryToken = await w.tokenFor(w.a, primary.id, 'resident');
    const theirs = await create(
      memberToken,
      passBody({ visitorName: 'Their Guest', visitorPhone: uniquePhone() }),
      fresh.id,
    ).expect(201);
    const mine = await create(
      primaryToken,
      passBody({ visitorName: 'My Guest' }),
      fresh.id,
    ).expect(201);
    const asPrimary = (
      await call(w, 'GET', passes(fresh.id), { token: primaryToken }).expect(
        200,
      )
    ).body as {
      data: { id: string; mine: boolean; visitorName: string | null }[];
    };
    expect(asPrimary.data.map((p) => [p.id, p.mine, p.visitorName])).toEqual([
      [(mine.body as { id: string }).id, true, 'My Guest'],
      [(theirs.body as { id: string }).id, false, null],
    ]);
    const asMember = (
      await call(w, 'GET', passes(fresh.id), { token: memberToken }).expect(200)
    ).body as { data: { id: string; visitorName: string | null }[] };
    expect(asMember.data).toEqual([
      expect.objectContaining({
        id: (theirs.body as { id: string }).id,
        visitorName: 'Their Guest',
      }),
    ]);
    expect(JSON.stringify(asMember)).not.toContain('+20');
  });

  it('a pass is checked: window, schedule, past start, phone', async () => {
    const bad = async (body: object) =>
      err(await create(owner(), passBody(body)));
    expect((await bad({ kind: 'recurring' })).fields).toEqual([
      { field: 'schedule', code: 'FIELD_REQUIRED' },
    ]);
    expect((await bad({ schedule: RECURRING.schedule })).fields).toEqual([
      { field: 'schedule', code: 'FIELD_NOT_ALLOWED' },
    ]);
    expect(
      (
        await bad({
          validUntil: new Date(Date.now() + 8 * 86_400_000).toISOString(),
        })
      ).fields,
    ).toEqual([
      { field: 'validUntil', code: 'INVALID_VALUE', params: { maxDays: 7 } },
    ]);
    expect(
      (
        await bad({
          validFrom: new Date(Date.now() - 3_600_000).toISOString(),
        })
      ).fields,
    ).toEqual([{ field: 'validFrom', code: 'INVALID_VALUE' }]);
    expect(
      (
        await bad({
          ...RECURRING,
          schedule: { days: [9], windows: [{ from: '10:00', to: '10:00' }] },
        })
      ).fields,
    ).toEqual([
      {
        field: 'schedule.days',
        code: 'INVALID_VALUE',
        params: { min: 0, max: 6 },
      },
      { field: 'schedule.windows', code: 'INVALID_SCHEDULE' },
    ]);
  });

  it('the compound caps active passes per unit', async () => {
    const fresh = await w.helpers.unit(w.a);
    const host = await w.helpers.resident(w.a, [fresh.id]);
    const token = await w.tokenFor(w.a, host.id, 'resident');
    await call(w, 'PATCH', '/settings', {
      token: w.a.tokens.manager,
      body: { maxActiveVisitorPasses: 2 },
    }).expect(200);
    try {
      await create(token, passBody(), fresh.id).expect(201);
      const second = await create(token, passBody(), fresh.id).expect(201);
      const third = await create(token, passBody(), fresh.id);
      expect(status(third)).toEqual({
        status: 409,
        code: 'VISITOR_PASS_LIMIT_REACHED',
      });
      expect(err(third).params).toEqual({ max: 2 });
      // A cancelled pass frees its place.
      await call(
        w,
        'POST',
        `/visitor-passes/${(second.body as { id: string }).id}/cancel`,
        { token, body: { reasonCode: 'plans_changed' } },
      ).expect(204);
      await create(token, passBody(), fresh.id).expect(201);
    } finally {
      await call(w, 'PATCH', '/settings', {
        token: w.a.tokens.manager,
        body: { maxActiveVisitorPasses: 50 },
      }).expect(200);
    }
  });

  it('cancel: the host or the primary; a reason code; idempotent', async () => {
    const byTenant = await create(
      w.a.tokens.tenant,
      passBody(),
      w.a.rentedUnitId,
    ).expect(201);
    const id = (byTenant.body as { id: string }).id;
    const cancel = (token: string, body: object = { reasonCode: 'other' }) =>
      call(w, 'POST', `/visitor-passes/${id}/cancel`, { token, body });
    // Someone with no say over it: not found.
    expect(status(await cancel(owner()))).toEqual({
      status: 404,
      code: 'VISITOR_PASS_NOT_FOUND',
    });
    expect(status(await cancel(w.a.tokens.tenant, {}))).toEqual({
      status: 400,
      code: 'REASON_REQUIRED',
    });
    const unknown = await cancel(w.a.tokens.tenant, { reasonCode: 'bored' });
    expect(err(unknown).fields).toEqual([
      {
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
        params: { allowed: ['not_needed', 'plans_changed', 'other'] },
      },
    ]);
    await cancel(w.a.tokens.tenant).expect(204);
    await cancel(w.a.tokens.tenant).expect(204);
    expect(await passRow(id)).toMatchObject({
      status: 'cancelled',
      codeHash: null,
      cancelReasonCode: 'other',
    });
    // The owner of home (its primary) cancels a family member's pass.
    const familyPass = await create(w.a.tokens.family, passBody()).expect(201);
    await call(
      w,
      'POST',
      `/visitor-passes/${(familyPass.body as { id: string }).id}/cancel`,
      { token: owner(), body: { reasonCode: 'not_needed' } },
    ).expect(204);
  });

  it('Idempotency-Key: a retry gets the same pass and a new code; the first dies', async () => {
    const key = `pass-${Date.now()}`;
    const body = passBody();
    const first = await create(owner(), body, undefined, key).expect(201);
    const before = await passRow((first.body as { id: string }).id);
    const retry = await create(owner(), body, undefined, key).expect(201);
    expect((retry.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
    expect((retry.body as { code: string }).code).toMatch(/^\d{6}$/);
    const after = await passRow((first.body as { id: string }).id);
    expect(after.codeHash).not.toBe(before.codeHash);
    const rows = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'visitor_pass.code_reissued',
      targetId: after.id,
    });
    expect(rows).toHaveLength(1);
    const other = await create(
      owner(),
      passBody({ partySize: 9 }),
      undefined,
      key,
    );
    expect(status(other)).toEqual({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const raced = `pass-race-${Date.now()}`;
    const [x, y] = await Promise.all([
      create(owner(), body, undefined, raced),
      create(owner(), body, undefined, raced),
    ]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect((x.body as { id: string }).id).toBe((y.body as { id: string }).id);
    const count = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.visitorPass.count({
        where: { idempotencyKey: raced },
      }),
    );
    expect(count).toBe(1);
  });

  it('a host who is deactivated loses their active passes', async () => {
    const fresh = await w.helpers.unit(w.a);
    const host = await w.helpers.resident(w.a, [fresh.id]);
    const token = await w.tokenFor(w.a, host.id, 'resident');
    const pass = await create(token, passBody(), fresh.id).expect(201);
    await call(w, 'PATCH', `/accounts/${host.id}/status`, {
      token: w.a.tokens.manager,
      body: { status: 'inactive' },
    }).expect(200);
    expect(await passRow((pass.body as { id: string }).id)).toMatchObject({
      status: 'cancelled',
      cancelReasonCode: 'host_inactive',
      codeHash: null,
    });
  });

  it('gate instructions: defaults, set by the primary, not by a member', async () => {
    const path = `/units/${w.a.homeUnitId}/gate-instructions`;
    const before = await call(w, 'GET', path, { token: owner() }).expect(200);
    expect(keyPaths(before.body)).toEqual([
      'delivery',
      'uninvitedVisitor',
      'updatedAt',
    ]);
    const set = await call(w, 'PUT', path, {
      token: owner(),
      body: { uninvitedVisitor: 'deny', delivery: 'leave_at_gate' },
    }).expect(200);
    expect(set.body).toMatchObject({
      uninvitedVisitor: 'deny',
      delivery: 'leave_at_gate',
      updatedAt: expect.any(String) as string,
    });
    const member = await call(w, 'PUT', path, {
      token: w.a.tokens.family,
      body: { uninvitedVisitor: 'allow', delivery: 'allow' },
    });
    expect(status(member)).toEqual({
      status: 403,
      code: 'NOT_PRIMARY_RESIDENT',
    });
    await call(w, 'PUT', path, {
      token: owner(),
      body: { uninvitedVisitor: 'ask', delivery: 'ask' },
    }).expect(200);
  });

  it('retention: an ended pass loses its code, its visitor data 30 days on', async () => {
    const res = await create(
      owner(),
      passBody({
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
        visitorName: 'Retained Guest',
        visitorPhone: uniquePhone(),
      }),
    ).expect(201);
    const id = (res.body as { id: string }).id;
    const detailsId = (await passRow(id)).visitorDetailsId!;
    const sweep = h.moduleRef.get(SweepRunner);
    await sweep.run(VISITOR_DATA_SWEEP, new Date(Date.now() + 2 * 3_600_000));
    expect(await passRow(id)).toMatchObject({
      status: 'expired',
      codeHash: null,
      visitorDetailsId: detailsId,
    });
    await sweep.run(
      VISITOR_DATA_SWEEP,
      new Date(Date.now() + 31 * 86_400_000 + 2 * 3_600_000),
    );
    expect(await passRow(id)).toMatchObject({
      status: 'expired',
      visitorDetailsId: null,
    });
    const left = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.visitorDetails.count({
        where: { id: detailsId },
      }),
    );
    expect(left).toBe(0);
  });
});
