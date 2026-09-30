import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const GRANT = ['capPerOperation', 'grantedAt', 'permission'];

describe('API v0 — member permissions', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  async function home() {
    const unit = await w.helpers.unit(w.a);
    const owner = await w.helpers.resident(w.a, [unit.id]);
    const family = await w.helpers.joinFamily(w.a, unit.id, owner);
    return {
      unitId: unit.id,
      family,
      owner: await w.tokenFor(w.a, owner.id, 'resident'),
      familyToken: await w.tokenFor(w.a, family.id, 'family'),
    };
  }

  it('grant finance with a cap, revoke it, revoke everything', async () => {
    const hm = await home();
    const member = hm.family.memberId;
    const listed = await call(
      w,
      'GET',
      `/household/members/${member}/permissions`,
      {
        token: hm.owner,
      },
    ).expect(200);
    expect(keyPaths(listed.body)).toEqual(
      ['grants', ...GRANT.map((k) => `grants[].${k}`), 'memberId'].sort(),
    );

    const granted = await call(
      w,
      'POST',
      `/household/members/${member}/permissions/grant`,
      {
        token: hm.owner,
        body: { permission: 'finance', capPerOperation: '500' },
      },
    ).expect(201);
    expect(keyPaths(granted.body)).toEqual(GRANT);
    expect(granted.body).toMatchObject({ capPerOperation: '500.00' });
    const caps = await call(w, 'GET', `/me/units/${hm.unitId}/capabilities`, {
      token: hm.familyToken,
    }).expect(200);
    expect(caps.body).toMatchObject({
      financeView: true,
      financeCapPerOperation: '500.00',
    });

    await call(w, 'POST', `/household/members/${member}/permissions/revoke`, {
      token: hm.owner,
      body: {
        permission: 'finance',
        reasonCode: 'misuse',
        reason: 'Overspent',
      },
    }).expect(204);
    await call(
      w,
      'POST',
      `/household/members/${member}/permissions/revoke-all`,
      {
        token: hm.owner,
        body: { reasonCode: 'no_longer_needed', reason: 'Moving out' },
      },
    ).expect(204);
    const after = await call(
      w,
      'GET',
      `/household/members/${member}/permissions`,
      {
        token: hm.owner,
      },
    ).expect(200);
    expect(after.body).toMatchObject({ grants: [] });
  });

  it('the manager revokes during a separation', async () => {
    const hm = await home();
    await call(w, 'POST', `/units/${hm.unitId}/separation`, {
      token: w.a.tokens.manager,
      body: { reasonCode: 'separation', reason: 'Private' },
    }).expect(201);
    await call(
      w,
      'POST',
      `/household/members/${hm.family.memberId}/permissions/revoke-by-management`,
      {
        token: w.a.tokens.manager,
        body: {
          permission: 'all',
          reasonCode: 'security',
          reason: 'Separation',
        },
      },
    ).expect(204);
  });

  it('deferred actions: listed without the payload, declined with a reason', async () => {
    const hm = await home();
    const id = await w.helpers.as(
      w.a,
      { id: hm.family.id, type: 'family' },
      () =>
        h.moduleRef.get(TenantTx).withTenantTx((tx) =>
          h.moduleRef.get(MemberPermissionsService).submitDeferredAction(tx, {
            accountId: hm.family.id,
            unitId: hm.unitId,
            permission: 'bookings',
            payload: { court: 'Tennis 2', note: 'A private note' },
          }),
        ),
    );
    const list = await call(w, 'GET', `/units/${hm.unitId}/deferred-actions`, {
      token: hm.owner,
    }).expect(200);
    expect(keyPaths(list.body)).toEqual(
      listKeys(['createdAt', 'id', 'memberId', 'permission']),
    );
    expect(JSON.stringify(list.body)).not.toContain('A private note');

    const noReason = await call(w, 'POST', `/deferred-actions/${id}/decide`, {
      token: hm.owner,
      body: { decision: 'decline' },
    });
    expect(err(noReason).code).toBe('REASON_REQUIRED');
    await call(w, 'POST', `/deferred-actions/${id}/decide`, {
      token: hm.owner,
      body: {
        decision: 'decline',
        reasonCode: 'not_needed',
        reason: 'Not this week',
      },
    }).expect(204);
  });
});
