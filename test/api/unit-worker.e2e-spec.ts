import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths } from './keys';
import { call, err } from './request';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

/**
 * ADR 0037: one of the unit's workers, for its residents: the list item and
 * the last month paid. Never another unit's engagement, never a landlord,
 * and the manager's `GET /worker-engagements/:id` is left as it is.
 */
describe('API v0 — a unit’s worker', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const owner = () => w.a.tokens.owner;
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);

  async function engagement(unitId = w.a.homeUnitId, token = owner()) {
    const res = await call(w, 'POST', `/units/${unitId}/workers`, {
      token,
      body: workerBody(),
    }).expect(201);
    return (res.body as { engagementId: string }).engagementId;
  }

  it('the list item, the wage and the last month paid', async () => {
    const id = await engagement();
    const get = () =>
      call(w, 'GET', `/units/${w.a.homeUnitId}/workers/${id}`, {
        token: owner(),
      });
    const pending = await get().expect(200);
    expect(keyPaths(pending.body)).toEqual(
      [
        'capacity',
        'id',
        'lastPaidPeriod',
        'monthlyWage',
        'schedule',
        'schedule.days',
        'schedule.windows',
        'schedule.windows[].from',
        'schedule.windows[].to',
        'status',
        'suspendedByManagement',
        'validUntil',
        'workerName',
      ].sort(),
    );
    expect(pending.body).toMatchObject({
      id,
      status: 'pending_review',
      monthlyWage: null,
      lastPaidPeriod: null,
    });
    // The list and the detail agree.
    const list = await call(w, 'GET', `/units/${w.a.homeUnitId}/workers`, {
      token: owner(),
    }).expect(200);
    const item = { ...(pending.body as Record<string, unknown>) };
    delete item.lastPaidPeriod;
    expect((list.body as { data: unknown[] }).data).toContainEqual(item);

    await call(w, 'POST', `/worker-engagements/${id}/review`, {
      token: w.a.tokens.manager,
      body: { decision: 'approve' },
    }).expect(200);
    await call(w, 'PUT', `/worker-engagements/${id}/wage`, {
      token: owner(),
      body: { monthlyWage: '2500' },
    }).expect(200);
    await call(w, 'POST', `/worker-engagements/${id}/wage-payments`, {
      token: owner(),
      body: { period: month, amount: '2500' },
    }).expect(201);
    expect((await get().expect(200)).body).toMatchObject({
      status: 'active',
      monthlyWage: '2500.00',
      lastPaidPeriod: month,
    });
    // A household member sees it too, as in the list.
    await call(w, 'GET', `/units/${w.a.homeUnitId}/workers/${id}`, {
      token: w.a.tokens.family,
    }).expect(200);
  });

  it('only the unit’s own: another unit’s engagement through this unit, a neighbour, a landlord', async () => {
    const id = await engagement();
    // The tenant's unit, the owner's engagement: not this unit's.
    const tenantsOwn = await engagement(w.a.rentedUnitId, w.a.tokens.tenant);
    const crossed = await call(
      w,
      'GET',
      `/units/${w.a.rentedUnitId}/workers/${id}`,
      { token: w.a.tokens.tenant },
    );
    expect({ status: crossed.status, code: err(crossed).code }).toEqual({
      status: 404,
      code: 'ENGAGEMENT_NOT_FOUND',
    });
    const neighbour = await call(
      w,
      'GET',
      `/units/${w.a.homeUnitId}/workers/${id}`,
      { token: w.a.tokens.tenant },
    );
    expect({ status: neighbour.status, code: err(neighbour).code }).toEqual({
      status: 404,
      code: 'UNIT_NOT_FOUND',
    });
    // A landlord sees the unit, never who works in it (ADR 0020).
    const landlord = await call(
      w,
      'GET',
      `/units/${w.a.rentedUnitId}/workers/${tenantsOwn}`,
      { token: w.a.tokens.landlord },
    );
    expect(landlord.status).toBe(403);
    // The manager's route is unchanged; this one is not theirs.
    await call(w, 'GET', `/units/${w.a.homeUnitId}/workers/${id}`, {
      token: w.a.tokens.manager,
    }).expect(403);
  });

  it('a rejected engagement is gone, like from the list', async () => {
    const id = await engagement();
    await call(w, 'POST', `/worker-engagements/${id}/review`, {
      token: w.a.tokens.manager,
      body: {
        decision: 'reject',
        reasonCode: 'documents_invalid',
        reason: 'Blurred',
      },
    }).expect(200);
    const res = await call(w, 'GET', `/units/${w.a.homeUnitId}/workers/${id}`, {
      token: owner(),
    });
    expect({ status: res.status, code: err(res).code }).toEqual({
      status: 404,
      code: 'ENGAGEMENT_NOT_FOUND',
    });
  });
});
