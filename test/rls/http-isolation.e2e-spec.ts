import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/**
 * Exit criterion 1 over HTTP, plus the guards around it: the tenant comes
 * only from the token, never from the request body.
 */
describe('RLS tenant isolation (HTTP)', () => {
  let h: HttpHarness;
  let a: { id: string; name: string };
  let b: { id: string; name: string };
  let managerA: string;
  let managerB: string;
  let residentA: string;
  let unitA: { id: string };
  let accountA: { id: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    a = await h.createTenant('Compound A');
    b = await h.createTenant('Compound B');

    const mA = await h.createAccount(a.id, {
      type: 'manager',
      email: uniqueEmail('mgr-a'),
      phone: uniquePhone(),
    });
    const mB = await h.createAccount(b.id, {
      type: 'manager',
      email: uniqueEmail('mgr-b'),
      phone: uniquePhone(),
    });
    accountA = await h.createAccount(a.id, {
      type: 'resident',
      email: uniqueEmail('res-a'),
      phone: uniquePhone(),
    });

    managerA = await h.tokenFor({ sub: mA.id, tid: a.id, typ: 'manager' });
    managerB = await h.tokenFor({ sub: mB.id, tid: b.id, typ: 'manager' });
    residentA = await h.tokenFor({
      sub: accountA.id,
      tid: a.id,
      typ: 'resident',
    });

    const created = await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${managerA}`)
      .send({ code: 'A-101', building: 'A', floor: 1 })
      .expect(201);
    unitA = created.body as { id: string };
    await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${managerB}`)
      .send({ code: 'B-201' })
      .expect(201);
  });

  afterAll(() => h.close());

  it("B's unit list does not include A's unit", async () => {
    const res = await h
      .http()
      .get(`${API}/units`)
      .set('Authorization', `Bearer ${managerB}`)
      .expect(200);
    const codes = (res.body as { code: string }[]).map((u) => u.code);
    expect(codes).toEqual(['B-201']);
  });

  it("B fetching A's unit by id gets 404", async () => {
    const res = await h
      .http()
      .get(`${API}/units/${unitA.id}`)
      .set('Authorization', `Bearer ${managerB}`)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it("B's account list does not include A's accounts", async () => {
    const res = await h
      .http()
      .get(`${API}/accounts`)
      .set('Authorization', `Bearer ${managerB}`)
      .expect(200);
    const ids = (res.body as { id: string }[]).map((x) => x.id);
    expect(ids).not.toContain(accountA.id);
    expect(ids).toHaveLength(1);
  });

  it("B fetching A's account by id gets 404", async () => {
    await h
      .http()
      .get(`${API}/accounts/${accountA.id}`)
      .set('Authorization', `Bearer ${managerB}`)
      .expect(404);
  });

  it("B cannot deactivate A's account", async () => {
    await h
      .http()
      .patch(`${API}/accounts/${accountA.id}/status`)
      .set('Authorization', `Bearer ${managerB}`)
      .send({ status: 'inactive' })
      .expect(404);
    const res = await h
      .http()
      .get(`${API}/accounts/me`)
      .set('Authorization', `Bearer ${residentA}`)
      .expect(200);
    expect(res.body).toMatchObject({ id: accountA.id, status: 'active' });
  });

  it('A sees its own unit', async () => {
    const res = await h
      .http()
      .get(`${API}/units/${unitA.id}`)
      .set('Authorization', `Bearer ${managerA}`)
      .expect(200);
    expect(res.body).toMatchObject({ code: 'A-101', building: 'A', floor: 1 });
  });

  it('a tenantId in the body is rejected before it reaches the database', async () => {
    const res = await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${managerA}`)
      .send({ code: 'A-999', tenantId: b.id })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(res.body)).toContain('tenantId');
  });

  it('a duplicate unit code is a neutral 409', async () => {
    const res = await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${managerA}`)
      .send({ code: 'A-101' })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'CONFLICT' });
    expect(JSON.stringify(res.body)).not.toContain(unitA.id);
  });

  it('requires authentication', async () => {
    await h.http().get(`${API}/units`).expect(401);
    await h
      .http()
      .get(`${API}/units`)
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('only managers create units and accounts', async () => {
    await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${residentA}`)
      .send({ code: 'R-1' })
      .expect(403);
    await h
      .http()
      .get(`${API}/accounts`)
      .set('Authorization', `Bearer ${residentA}`)
      .expect(403);
  });
});
