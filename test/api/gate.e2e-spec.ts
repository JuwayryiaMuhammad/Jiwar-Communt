import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import { gateHelpers } from '../setup/gate';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const GATE = ['createdAt', 'id', 'kind', 'name', 'status'];
const SHIFT = ['endedAt', 'gateId', 'gateName', 'id', 'startedAt'];

describe('API v0 — gates and shifts (ADR 0028)', () => {
  let h: HttpHarness;
  let w: World;
  let g: ReturnType<typeof gateHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    g = gateHelpers(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;
  const code = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });

  /** A fresh guard (created over HTTP: staff accounts are creatable now). */
  async function newGuard(body: object = {}) {
    const res = await call(w, 'POST', '/accounts', {
      token: manager(),
      body: {
        type: 'staff',
        fullName: `Guard ${uniqueSuffix()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail('guard'),
        ...body,
      },
    });
    return res;
  }
  async function guardToken() {
    const res = await newGuard();
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    return { id, token: await w.tokenFor(w.a, id, 'staff') };
  }

  it('managers set up gates; guards see the active ones', async () => {
    const name = `North ${uniqueSuffix()}`;
    const created = await call(w, 'POST', '/gates', {
      token: manager(),
      body: { name, kind: 'pedestrian' },
    }).expect(201);
    expect(keyPaths(created.body)).toEqual(GATE);
    const id = (created.body as { id: string }).id;

    const dup = await call(w, 'POST', '/gates', {
      token: manager(),
      body: { name, kind: 'vehicle' },
    });
    expect(code(dup)).toEqual({ status: 409, code: 'DUPLICATE_RESOURCE' });
    expect(err(dup).fields).toEqual([
      { field: 'name', code: 'DUPLICATE_VALUE' },
    ]);

    const list = await call(w, 'GET', '/gates', { token: manager() }).expect(
      200,
    );
    expect(keyPaths(list.body)).toEqual(listKeys(GATE));

    const guard = await guardToken();
    const seen = async () =>
      (
        (
          await call(w, 'GET', '/gate/gates', { token: guard.token }).expect(
            200,
          )
        ).body as { data: { id: string }[] }
      ).data.map((x) => x.id);
    const guardList = await call(w, 'GET', '/gate/gates', {
      token: guard.token,
    }).expect(200);
    expect(keyPaths(guardList.body)).toEqual(listKeys(['id', 'kind', 'name']));
    expect(await seen()).toContain(id);

    const patched = await call(w, 'PATCH', `/gates/${id}`, {
      token: manager(),
      body: { status: 'inactive' },
    }).expect(200);
    expect(patched.body).toMatchObject({ status: 'inactive' });
    expect(await seen()).not.toContain(id);
    const atInactive = await call(w, 'POST', '/gate/shifts/start', {
      token: guard.token,
      body: { gateId: id },
    });
    expect(code(atInactive)).toEqual({ status: 404, code: 'GATE_NOT_FOUND' });
  });

  it('a shift: none, start, one at a time, current, end', async () => {
    const guard = await guardToken();
    const none = await call(w, 'GET', '/gate/shifts/current', {
      token: guard.token,
    });
    expect(code(none)).toEqual({ status: 403, code: 'NO_OPEN_SHIFT' });

    const started = await call(w, 'POST', '/gate/shifts/start', {
      token: guard.token,
      body: { gateId: w.a.gateId },
    }).expect(201);
    expect(keyPaths(started.body)).toEqual(SHIFT);
    expect(started.body).toMatchObject({
      gateId: w.a.gateId,
      gateName: w.a.gateName,
      endedAt: null,
    });
    const again = await call(w, 'POST', '/gate/shifts/start', {
      token: guard.token,
      body: { gateId: w.a.gateId },
    });
    expect(code(again)).toEqual({ status: 409, code: 'SHIFT_ALREADY_OPEN' });

    const current = await call(w, 'GET', '/gate/shifts/current', {
      token: guard.token,
    }).expect(200);
    expect(current.body).toEqual(started.body);

    const ended = await call(w, 'POST', '/gate/shifts/end', {
      token: guard.token,
    }).expect(200);
    expect(ended.body).toMatchObject({
      id: (started.body as { id: string }).id,
      endedAt: expect.any(String) as string,
    });
    const after = await call(w, 'POST', '/gate/shifts/end', {
      token: guard.token,
    });
    expect(code(after)).toEqual({ status: 403, code: 'NO_OPEN_SHIFT' });
  });

  it('start and end are idempotent under Idempotency-Key', async () => {
    const guard = await guardToken();
    const start = () =>
      w.h
        .http()
        .post('/api/v1/gate/shifts/start')
        .set('Authorization', `Bearer ${guard.token}`)
        .set('Idempotency-Key', 'start-key-0001')
        .send({ gateId: w.a.gateId });
    const [x, y] = await Promise.all([start(), start()]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body).toEqual(y.body);
    const end = () =>
      w.h
        .http()
        .post('/api/v1/gate/shifts/end')
        .set('Authorization', `Bearer ${guard.token}`)
        .set('Idempotency-Key', 'end-key-00001')
        .send({});
    const first = await end().expect(200);
    const retry = await end().expect(200);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  it('a gate deactivated or a guard deactivated ends the open shift', async () => {
    const at = await g.gate(w.a);
    const one = await guardToken();
    await call(w, 'POST', '/gate/shifts/start', {
      token: one.token,
      body: { gateId: at.id },
    }).expect(201);
    await call(w, 'PATCH', `/gates/${at.id}`, {
      token: manager(),
      body: { status: 'inactive' },
    }).expect(200);
    expect(
      code(await call(w, 'GET', '/gate/shifts/current', { token: one.token })),
    ).toEqual({ status: 403, code: 'NO_OPEN_SHIFT' });

    const two = await guardToken();
    await call(w, 'POST', '/gate/shifts/start', {
      token: two.token,
      body: { gateId: w.a.gateId },
    }).expect(201);
    await call(w, 'PATCH', `/accounts/${two.id}/status`, {
      token: manager(),
      body: { status: 'inactive' },
    }).expect(200);
    const shift = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.guardShift.findFirstOrThrow({
        where: { guardAccountId: two.id },
      }),
    );
    expect(shift).toMatchObject({ endReason: 'account_deactivated' });
    expect(shift.endedAt).not.toBeNull();
  });

  it('staff accounts: guard by default, another staff role by key, nothing else', async () => {
    const byDefault = await newGuard();
    expect(byDefault.status).toBe(201);
    const roleOf = (id: string) =>
      w.helpers.asManager(
        w.a,
        async () =>
          (
            await w.helpers.prisma.tenant.account.findUniqueOrThrow({
              where: { id },
              include: { role: true },
            })
          ).role.key,
      );
    expect(await roleOf((byDefault.body as { id: string }).id)).toBe('guard');

    // The other staff roles (ADR 0032): a technician and a maintenance
    // supervisor are created the same way, by naming the role.
    for (const roleKey of ['technician', 'maintenance_supervisor']) {
      const explicit = await newGuard({ roleKey });
      expect(explicit.status).toBe(201);
      expect(await roleOf((explicit.body as { id: string }).id)).toBe(roleKey);
    }

    for (const roleKey of ['nope', 'manager', 'resident']) {
      const res = await newGuard({ roleKey });
      expect(code(res)).toEqual({ status: 404, code: 'ROLE_NOT_FOUND' });
    }
    // Another kind with a staff role is refused too.
    const resident = await call(w, 'POST', '/accounts', {
      token: manager(),
      body: {
        type: 'resident',
        fullName: `Resident ${uniqueSuffix()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail('resident'),
        roleKey: 'guard',
      },
    });
    expect(code(resident)).toEqual({ status: 404, code: 'ROLE_NOT_FOUND' });
  });
});
