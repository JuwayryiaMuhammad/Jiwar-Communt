import { Client } from 'pg';
import { AccessTokens } from '../../src/core/auth/access-token';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PassTokens } from '../../src/gate/visitors/pass-tokens';
import { VISITOR_DATA_SWEEP } from '../../src/gate/visitors/visitor-data.sweep';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { passBody } from './routes/visitors';
import { buildWorld, type World } from './world';
import { leakText } from '../setup/leak-text';

const ISSUED = [
  'code',
  'id',
  'kind',
  'link',
  'partySize',
  'qrPayload',
  'schedule',
  'status',
  'validFrom',
  'validUntil',
];
const LISTED = [
  'createdAt',
  'enteredAt',
  'entriesUsed',
  'exitedAt',
  'id',
  'kind',
  'mine',
  'partySize',
  'schedule',
  'status',
  'validFrom',
  'validUntil',
  'vehiclePlate',
  'visitorName',
];
const DETAIL = [
  ...LISTED,
  'code',
  'createdBy',
  'createdBy.fullName',
  'createdBy.id',
  'link',
  'qrPayload',
  // Security refused its visitor (ADR 0053).
  'refusedBySecurity',
  'visitorPhoneMasked',
].sort();
const LINK = /^https:\/\/app\.jiwar\.test\/v#([A-Za-z0-9_-]{43})$/;
/** The token in a pass's link (ADR 0030). */
const tokenOf = (body: unknown) => {
  const link = (body as { link: string }).link;
  const m = LINK.exec(link);
  if (!m) throw new Error(`not a visitor link: ${link}`);
  return m[1];
};
const DAY = 86_400_000;

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
  const tokens = () => h.moduleRef.get(AccessTokens);
  const passTokens = () => h.moduleRef.get(PassTokens);
  const hasher = () => h.moduleRef.get(IdentifierHasher);
  const linkOf = (token: string) =>
    h.moduleRef.get(GlobalDbService).visitorPassLink.findUnique({
      where: { tokenHash: hasher().hashVisitorLink(token) },
    });
  const verify = (code: string) =>
    call(w, 'POST', '/gate/verify', {
      token: w.a.tokens.guard,
      body: { code },
    }).expect(200);
  const reissue = (token: string, id: string, key?: string) => {
    let req = w.h
      .http()
      .post(`/api/v1/visitor-passes/${id}/reissue-link`)
      .set('Authorization', `Bearer ${token}`);
    if (key) req = req.set('Idempotency-Key', key);
    return req.send();
  };

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

  it('every member reads a pass; secrets to the host and the primary, visitor data to the host', async () => {
    const fresh = await w.helpers.unit(w.a);
    const primary = await w.helpers.resident(w.a, [fresh.id]);
    const member = await w.helpers.joinFamily(w.a, fresh.id, primary);
    const other = await w.helpers.joinFamily(w.a, fresh.id, primary);
    const memberToken = await w.tokenFor(w.a, member.id, 'family');
    const otherToken = await w.tokenFor(w.a, other.id, 'family');
    const primaryToken = await w.tokenFor(w.a, primary.id, 'resident');
    // `other` may not invite: still a member of the unit, still a reader.
    await call(
      w,
      'POST',
      `/household/members/${other.memberId}/permissions/revoke`,
      {
        token: primaryToken,
        body: {
          permission: 'visitors_invite',
          reasonCode: 'no_longer_needed',
          reason: 'Test',
        },
      },
    ).expect(204);
    const phone = uniquePhone();
    const created = await create(
      memberToken,
      passBody({
        partySize: 1,
        visitorName: 'Detail Guest',
        visitorPhone: phone,
        vehiclePlate: ' ق  ب ط ١٢٣٤ ',
      }),
      fresh.id,
    ).expect(201);
    const { id, code, link, qrPayload } = created.body as {
      id: string;
      code: string;
      link: string;
      qrPayload: string;
    };
    const get = (token: string) =>
      call(w, 'GET', `/visitor-passes/${id}`, { token });

    const asHost = await get(memberToken).expect(200);
    expect(asHost.headers['cache-control']).toBe('no-store');
    expect(keyPaths(asHost.body)).toEqual(DETAIL);
    expect(asHost.body).toMatchObject({
      id,
      status: 'active',
      mine: true,
      code,
      link,
      qrPayload,
      visitorName: 'Detail Guest',
      vehiclePlate: 'ق ب ط ١٢٣٤',
      visitorPhoneMasked: `••••${phone.slice(-4)}`,
      createdBy: { id: member.id },
      enteredAt: null,
      exitedAt: null,
    });
    // The primary may manage it: the secrets, not the visitor's data.
    expect((await get(primaryToken).expect(200)).body).toMatchObject({
      mine: false,
      code,
      link,
      visitorName: null,
      vehiclePlate: null,
      visitorPhoneMasked: null,
    });
    // Any other member: the pass, nothing secret, nothing personal.
    const asOther = (await get(otherToken).expect(200)).body as Record<
      string,
      unknown
    >;
    expect(asOther).toMatchObject({
      id,
      code: null,
      link: null,
      qrPayload: null,
      visitorName: null,
      visitorPhoneMasked: null,
      createdBy: { id: member.id },
    });
    expect(leakText(asOther)).not.toContain(phone.slice(-4));
    // Another unit's resident: the same answer as an unknown pass.
    const foreign = await get(w.a.tokens.tenant);
    expect(status(foreign)).toEqual({
      status: 404,
      code: 'VISITOR_PASS_NOT_FOUND',
    });

    // A reissued link is what the detail shows from then on.
    const again = await reissue(memberToken, id).expect(200);
    expect((await get(primaryToken).expect(200)).body).toMatchObject({
      code: (again.body as { code: string }).code,
    });

    // In and out at the gate: the detail and the list show both, and a
    // one-time pass for one is used (its code gone).
    const entry = (direction: 'in' | 'out') =>
      call(w, 'POST', '/gate/entries', {
        token: w.a.tokens.guard,
        body: { subjectType: 'visitor_pass', subjectId: id, direction },
      }).expect(201);
    const inAt = (await entry('in')).body as { occurredAt: string };
    expect((await get(memberToken).expect(200)).body).toMatchObject({
      status: 'used',
      code: null,
      link: null,
      qrPayload: null,
      enteredAt: inAt.occurredAt,
      exitedAt: null,
    });
    const outAt = (await entry('out')).body as { occurredAt: string };
    const listed = (
      await call(w, 'GET', passes(fresh.id), { token: memberToken }).expect(200)
    ).body as { data: { id: string }[] };
    expect(listed.data.find((p) => p.id === id)).toMatchObject({
      enteredAt: inAt.occurredAt,
      exitedAt: outAt.occurredAt,
      vehiclePlate: 'ق ب ط ١٢٣٤',
    });
  });

  it('a pass issued before derived tokens shows no code until its link is reissued', async () => {
    const created = await create(owner(), passBody()).expect(201);
    const { id } = created.body as { id: string };
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.visitorPass.update({
        where: { id },
        data: { tokenSeq: null },
      }),
    );
    const get = () =>
      call(w, 'GET', `/visitor-passes/${id}`, { token: owner() }).expect(200);
    expect((await get()).body).toMatchObject({ status: 'active', code: null });
    const again = await reissue(owner(), id).expect(200);
    expect((await get()).body).toMatchObject({
      code: (again.body as { code: string }).code,
    });
  });

  it('a vehicle plate is letters, digits and spaces, 12 at most', async () => {
    for (const vehiclePlate of ['ABC-123', '1234567890123', '   '])
      expect(
        err(await create(owner(), passBody({ vehiclePlate }))).fields,
      ).toEqual([
        {
          field: 'vehiclePlate',
          code: 'INVALID_FORMAT',
          params: { maxLength: 12 },
        },
      ]);
    // The guard who checks the code sees the plate, never the name.
    const res = await create(
      owner(),
      passBody({ vehiclePlate: 'abc 123', visitorName: 'Plate Guest' }),
    ).expect(201);
    const checked = await verify((res.body as { code: string }).code);
    expect(checked.body).toMatchObject({
      result: 'valid',
      display: { vehiclePlate: 'ABC 123' },
    });
    expect(JSON.stringify(checked.body)).not.toContain('Plate Guest');
  });

  it("the mobile team's recurring body: windows are times of day", async () => {
    // Their exact body, dated from now. It followed the contract as it was
    // published: the schedule's window took a maintenance visit's schema
    // (two classes named VisitWindowDto), so it sent `startsAt`/`endsAt`.
    const from = new Date(Date.now() + 3_600_000);
    const mobile = {
      kind: 'recurring',
      partySize: 4,
      validFrom: from.toISOString(),
      validUntil: new Date(from.getTime() + 30 * DAY).toISOString(),
      schedule: {
        days: [2, 4],
        windows: [
          {
            startsAt: from.toISOString(),
            endsAt: new Date(from.getTime() + 2 * 3_600_000).toISOString(),
          },
        ],
      },
      visitorName: 'Family visit',
    };
    const refused = await create(owner(), mobile);
    expect(status(refused)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(err(refused).fields).toEqual([
      { field: 'schedule.windows.0.startsAt', code: 'FIELD_NOT_ALLOWED' },
      { field: 'schedule.windows.0.endsAt', code: 'FIELD_NOT_ALLOWED' },
      { field: 'schedule.windows.0.from', code: 'FIELD_REQUIRED' },
      { field: 'schedule.windows.0.to', code: 'FIELD_REQUIRED' },
    ]);

    const fixed = {
      ...mobile,
      schedule: { days: [2, 4], windows: [{ from: '16:00', to: '18:00' }] },
    };
    const created = await create(owner(), fixed).expect(201);
    expect(created.body).toMatchObject({
      kind: 'recurring',
      partySize: 4,
      schedule: fixed.schedule,
      status: 'active',
    });
    // An overnight window stays allowed; a malformed time names its field.
    await create(
      owner(),
      passBody({
        ...RECURRING,
        schedule: { days: [5], windows: [{ from: '22:00', to: '02:00' }] },
      }),
    ).expect(201);
    expect(
      err(
        await create(
          owner(),
          passBody({
            ...RECURRING,
            schedule: { days: [5], windows: [{ from: '7pm', to: '23:00' }] },
          }),
        ),
      ).fields,
    ).toEqual([{ field: 'schedule.windows.0.from', code: 'INVALID_FORMAT' }]);
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
      qrTokenHash: null,
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
    // A new code is a new token: the first link and QR die with it.
    expect(tokenOf(retry.body)).not.toBe(tokenOf(first.body));
    expect(after.qrTokenHash).not.toBe(before.qrTokenHash);
    expect(await linkOf(tokenOf(first.body))).toBeNull();
    expect(await linkOf(tokenOf(retry.body))).toMatchObject({
      passId: after.id,
    });
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
      qrTokenHash: null,
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
      qrTokenHash: null,
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

  // --------------------------------------------------------------------------
  // QR tokens (ADR 0030)
  // --------------------------------------------------------------------------

  it('a pass carries its link and QR: one token, the code derived from it', async () => {
    const res = await create(owner(), passBody()).expect(201);
    const body = res.body as { id: string; code: string; qrPayload: string };
    const token = tokenOf(body);
    expect(body.qrPayload).toBe(`JWR1.${token}`);
    expect(body.code).toBe(tokens().codeOf(token, 6));
    const row = await passRow(body.id);
    expect(row.codeHash).toBe(
      hasher().hashVisitorCode(w.a.tenantId, body.code),
    );
    expect(row.qrTokenHash).toBe(hasher().hashQrToken(w.a.tenantId, token));
    expect(await linkOf(token)).toEqual({
      tokenHash: hasher().hashVisitorLink(token),
      tenantId: w.a.tenantId,
      passId: body.id,
      expiresAt: new Date(row.validUntil.getTime() + 30 * DAY),
      createdAt: expect.any(Date) as Date,
    });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('a derived code already in use draws the next token', async () => {
    const first = await create(owner(), passBody()).expect(201);
    const firstId = (first.body as { id: string }).id;
    const taken = passTokens().secretOf(w.a.tenantId, firstId, 0);
    expect((first.body as { code: string }).code).toBe(taken.code);
    expect(tokenOf(first.body)).toBe(taken.token);
    // The second pass's first token derives the first pass's code.
    const spy = jest.spyOn(passTokens(), 'secretOf');
    try {
      spy.mockReturnValueOnce({ ...taken });
      const second = await create(owner(), passBody()).expect(201);
      const id = (second.body as { id: string }).id;
      const next = passTokens().secretOf(w.a.tenantId, id, 1);
      expect(second.body).toMatchObject({ code: next.code });
      expect(tokenOf(second.body)).toBe(next.token);
      expect(await passRow(id)).toMatchObject({
        tokenSeq: 1,
        codeHash: next.codeHash,
      });
      expect(await linkOf(taken.token)).toMatchObject({ passId: firstId });
    } finally {
      spy.mockRestore();
    }
  });

  it('reissue-link: a new link, QR and code for the same pass; the old ones die', async () => {
    const res = await create(owner(), passBody()).expect(201);
    const id = (res.body as { id: string }).id;
    const oldToken = tokenOf(res.body);
    const oldCode = (res.body as { code: string }).code;
    expect((await verify(oldCode)).body).toMatchObject({ result: 'valid' });

    const again = await reissue(owner(), id).expect(200);
    expect(again.headers['cache-control']).toBe('no-store');
    expect(keyPaths(again.body)).toEqual(ISSUED);
    const newToken = tokenOf(again.body);
    const newCode = (again.body as { code: string }).code;
    expect(newToken).not.toBe(oldToken);
    expect(newCode).toBe(tokens().codeOf(newToken, 6));
    expect(newCode).not.toBe(oldCode);
    expect(again.body).toMatchObject({
      id,
      status: 'active',
      qrPayload: `JWR1.${newToken}`,
    });
    expect(await passRow(id)).toMatchObject({
      codeHash: hasher().hashVisitorCode(w.a.tenantId, newCode),
      qrTokenHash: hasher().hashQrToken(w.a.tenantId, newToken),
    });
    expect(await linkOf(oldToken)).toBeNull();
    expect(
      await h.moduleRef
        .get(GlobalDbService)
        .visitorPassLink.count({ where: { passId: id } }),
    ).toBe(1);
    expect((await verify(oldCode)).body).toMatchObject({
      result: 'invalid',
      reason: 'unknown_code',
    });
    expect((await verify(newCode)).body).toMatchObject({ result: 'valid' });
    const audit = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'visitor_pass.code_reissued',
      targetId: id,
    });
    expect(audit.map((a) => a.metadata)).toEqual([{ reason: 'link_reissued' }]);
  });

  it('reissue-link: the host or the primary, an active pass only', async () => {
    const familyPass = await create(w.a.tokens.family, passBody()).expect(201);
    const familyId = (familyPass.body as { id: string }).id;
    // The unit's primary may; a resident of another unit may not.
    await reissue(owner(), familyId).expect(200);
    expect(status(await reissue(w.a.tokens.tenant, familyId))).toEqual({
      status: 404,
      code: 'VISITOR_PASS_NOT_FOUND',
    });
    // A family member is not the primary: the owner's pass is not theirs.
    const ownerPass = await create(owner(), passBody()).expect(201);
    const ownerId = (ownerPass.body as { id: string }).id;
    expect(status(await reissue(w.a.tokens.family, ownerId))).toEqual({
      status: 404,
      code: 'VISITOR_PASS_NOT_FOUND',
    });
    expect(status(await reissue(w.a.tokens.manager, ownerId))).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
    // Cancelled.
    await call(w, 'POST', `/visitor-passes/${ownerId}/cancel`, {
      token: owner(),
      body: { reasonCode: 'other' },
    }).expect(204);
    expect(status(await reissue(owner(), ownerId))).toEqual({
      status: 404,
      code: 'VISITOR_PASS_NOT_FOUND',
    });
    // Used by its one entry.
    const used = await create(owner(), passBody()).expect(201);
    const usedId = (used.body as { id: string }).id;
    await call(w, 'POST', '/gate/entries', {
      token: w.a.tokens.guard,
      body: {
        subjectType: 'visitor_pass',
        subjectId: usedId,
        direction: 'in',
      },
    }).expect(201);
    expect(await passRow(usedId)).toMatchObject({
      status: 'used',
      codeHash: null,
      qrTokenHash: null,
    });
    expect(status(await reissue(owner(), usedId))).toEqual({
      status: 404,
      code: 'VISITOR_PASS_NOT_FOUND',
    });
    await call(w, 'POST', '/gate/entries', {
      token: w.a.tokens.guard,
      body: {
        subjectType: 'visitor_pass',
        subjectId: usedId,
        direction: 'out',
      },
    }).expect(201);
  });

  it('reissue-link with Idempotency-Key: a replay reissues again and stores no secret', async () => {
    const res = await create(owner(), passBody()).expect(201);
    const id = (res.body as { id: string }).id;
    const key = `relink-${Date.now()}`;
    const first = await reissue(owner(), id, key).expect(200);
    const replay = await reissue(owner(), id, key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.headers['cache-control']).toBe('no-store');
    expect(keyPaths(replay.body)).toEqual(ISSUED);
    expect(tokenOf(replay.body)).not.toBe(tokenOf(first.body));
    expect(await linkOf(tokenOf(first.body))).toBeNull();
    expect(await linkOf(tokenOf(replay.body))).toMatchObject({ passId: id });
    const stored = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.idempotencyKey.findMany({ where: { key } }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].responseBody).toBeNull();
    const audit = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'visitor_pass.code_reissued',
      targetId: id,
    });
    expect(audit.map((a) => a.metadata)).toEqual([
      { reason: 'link_reissued' },
      { reason: 'idempotent_replay' },
    ]);
    // The key names this pass: another pass is another request.
    const other = await create(owner(), passBody()).expect(201);
    expect(
      status(await reissue(owner(), (other.body as { id: string }).id, key)),
    ).toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    // Replayed after the pass ended: what became of it, no secret.
    await call(w, 'POST', `/visitor-passes/${id}/cancel`, {
      token: owner(),
      body: { reasonCode: 'other' },
    }).expect(204);
    const late = await reissue(owner(), id, key).expect(200);
    expect(late.body).toMatchObject({
      id,
      status: 'cancelled',
      code: null,
      link: null,
      qrPayload: null,
    });
  });

  it('the database refuses a code rotated without its token', async () => {
    const res = await create(owner(), passBody()).expect(201);
    const id = (res.body as { id: string }).id;
    const db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    // FORCE ROW LEVEL SECURITY binds the table owner too.
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [
      w.a.tenantId,
    ]);
    try {
      await expect(
        db.query(
          `UPDATE visitor_passes SET code_hash = repeat('a', 64) WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('a visitor pass code changed without its token');
      // With the token, or cleared together: fine.
      await db.query(
        `UPDATE visitor_passes SET code_hash = repeat('b', 64),
                qr_token_hash = repeat('c', 64) WHERE id = $1`,
        [id],
      );
      await expect(
        db.query(
          `UPDATE visitor_passes SET qr_token_hash = repeat('d', 64),
                  code_hash = NULL WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow('visitor_passes_code_only_when_active');
    } finally {
      await db.end();
    }
  });
});
