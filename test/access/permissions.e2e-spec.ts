import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/**
 * PermissionsGuard on the Phase 0 endpoints (ADR 0010), and account /
 * compound status checked on every request (ADR 0004 update).
 */
describe('Permissions guard', () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await createHttpHarness();
  });

  afterAll(() => h.close());

  async function compound() {
    const tenant = await h.createTenant('Compound P');
    const manager = await h.createAccount(tenant.id, {
      type: 'manager',
      email: uniqueEmail('mgr'),
      phone: uniquePhone(),
    });
    const resident = await h.createAccount(tenant.id, {
      type: 'resident',
      email: uniqueEmail('res'),
      phone: uniquePhone(),
    });
    return {
      tenant,
      manager,
      resident,
      managerToken: await h.tokenFor({
        sub: manager.id,
        tid: tenant.id,
        typ: 'manager',
      }),
      residentToken: await h.tokenFor({
        sub: resident.id,
        tid: tenant.id,
        typ: 'resident',
      }),
    };
  }

  it('allows and denies per permission of the role', async () => {
    const c = await compound();
    const as = (token: string) => ({ Authorization: `Bearer ${token}` });

    await h.http().get(`${API}/units`).set(as(c.residentToken)).expect(200);
    const denied = await h
      .http()
      .post(`${API}/units`)
      .set(as(c.residentToken))
      .send({ code: 'R-1' })
      .expect(403);
    expect(denied.body).toMatchObject({ code: 'FORBIDDEN' });
    await h.http().get(`${API}/accounts`).set(as(c.residentToken)).expect(403);
    await h
      .http()
      .get(`${API}/accounts/me`)
      .set(as(c.residentToken))
      .expect(200);

    await h
      .http()
      .post(`${API}/units`)
      .set(as(c.managerToken))
      .send({ code: 'M-1' })
      .expect(201);
    await h.http().get(`${API}/accounts`).set(as(c.managerToken)).expect(200);
  });

  it('staff accounts cannot be created while staff has no role', async () => {
    const c = await compound();
    const res = await h
      .http()
      .post(`${API}/accounts`)
      .set('Authorization', `Bearer ${c.managerToken}`)
      .send({
        type: 'staff',
        fullName: 'Guard One',
        idDocumentType: 'national_id' as const,
        idDocumentNumber: '29001010134567',
        phone: uniquePhone(),
        email: uniqueEmail('staff'),
      })
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'NO_ROLE_FOR_ACCOUNT_TYPE',
      params: { type: 'staff' },
    });
  });

  it('a duplicate email names the field', async () => {
    const c = await compound();
    const email = uniqueEmail('dup');
    const body = {
      type: 'resident',
      fullName: 'Dup',
      idDocumentType: 'national_id' as const,
      idDocumentNumber: '29001010134568',
      email,
    };
    const send = () =>
      h
        .http()
        .post(`${API}/accounts`)
        .set('Authorization', `Bearer ${c.managerToken}`)
        .send({ ...body, phone: uniquePhone() });
    await send().expect(201);
    const res = await send().expect(409);
    expect(res.body).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      fields: [{ field: 'email', code: 'DUPLICATE_VALUE' }],
    });
  });

  it('a deactivated account is rejected on the next request', async () => {
    const c = await compound();
    await h
      .http()
      .patch(`${API}/accounts/${c.resident.id}/status`)
      .set('Authorization', `Bearer ${c.managerToken}`)
      .send({ status: 'inactive' })
      .expect(200);
    const res = await h
      .http()
      .get(`${API}/accounts/me`)
      .set('Authorization', `Bearer ${c.residentToken}`)
      .expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a suspended compound is rejected on the next request', async () => {
    const c = await compound();
    await h.suspendTenant(c.tenant.id);
    for (const token of [c.managerToken, c.residentToken]) {
      await h
        .http()
        .get(`${API}/accounts/me`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
  });

  it('a token for an account that does not exist in that tenant is rejected', async () => {
    const a = await compound();
    const b = await compound();
    // A real account id, but paired with another tenant.
    const forged = await h.tokenFor({
      sub: a.manager.id,
      tid: b.tenant.id,
      typ: 'manager',
    });
    await h
      .http()
      .get(`${API}/units`)
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });
});
