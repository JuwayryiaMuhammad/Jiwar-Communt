import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { inAMonth } from './routes/delegations';
import { buildWorld, type World } from './world';

describe('API v0 — delegations', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  it('the primary delegates, lists and revokes', async () => {
    const unit = await w.helpers.unit(w.a);
    const owner = await w.helpers.resident(w.a, [unit.id]);
    const family = await w.helpers.joinFamily(w.a, unit.id, owner);
    const token = await w.tokenFor(w.a, owner.id, 'resident');

    const created = await call(w, 'POST', `/units/${unit.id}/delegations`, {
      token,
      body: {
        delegateAccountId: family.id,
        scopes: ['household'],
        expiresAt: inAMonth(),
      },
    }).expect(201);
    expect(keyPaths(created.body)).toEqual([
      'delegateAccountId',
      'expiresAt',
      'id',
      'scopes',
      'unitId',
    ]);

    const list = await call(w, 'GET', `/units/${unit.id}/delegations`, {
      token,
    }).expect(200);
    expect(keyPaths(list.body)).toEqual(
      listKeys([
        'createdAt',
        'delegate',
        'delegate.fullName',
        'delegate.id',
        'expiresAt',
        'id',
        'scopes',
      ]),
    );
    expect(JSON.stringify(list.body)).not.toContain(family.email);

    const tooLong = await call(w, 'POST', `/units/${unit.id}/delegations`, {
      token,
      body: {
        delegateAccountId: family.id,
        scopes: ['workers'],
        expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      },
    });
    expect(err(tooLong).code).toBe('VALIDATION_FAILED');

    await call(
      w,
      'POST',
      `/delegations/${(created.body as { id: string }).id}/revoke`,
      {
        token,
      },
    ).expect(204);
    const empty = await call(w, 'GET', `/units/${unit.id}/delegations`, {
      token,
    }).expect(200);
    expect(empty.body).toEqual({ data: [], nextCursor: null });
  });
});
