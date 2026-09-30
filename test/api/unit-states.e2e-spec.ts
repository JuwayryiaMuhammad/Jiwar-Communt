import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

describe('API v0 — unit states', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;

  async function home() {
    const unit = await w.helpers.unit(w.a);
    const owner = await w.helpers.resident(w.a, [unit.id]);
    const family = await w.helpers.joinFamily(w.a, unit.id, owner);
    return { unitId: unit.id, owner, family };
  }

  it('death: flagged once, finance stops for the primary, cleared by code', async () => {
    const hm = await home();
    const flagged = await call(w, 'POST', `/units/${hm.unitId}/deceased`, {
      token: manager(),
      body: { reasonCode: 'deceased', reason: 'Condolences' },
    }).expect(201);
    expect(keyPaths(flagged.body)).toEqual(['flagId']);
    const again = await call(w, 'POST', `/units/${hm.unitId}/deceased`, {
      token: manager(),
      body: { reasonCode: 'deceased', reason: 'Twice' },
    }).expect(201);
    expect(again.body).toEqual(flagged.body);

    const ownerToken = await w.tokenFor(w.a, hm.owner.id, 'resident');
    const caps = await call(w, 'GET', `/me/units/${hm.unitId}/capabilities`, {
      token: ownerToken,
    }).expect(200);
    expect(caps.body).toMatchObject({
      financeView: false,
      householdManage: false,
    });

    const { flagId } = flagged.body as { flagId: string };
    const bad = await call(w, 'POST', `/review-flags/${flagId}/clear`, {
      token: manager(),
      body: { reasonCode: 'because' },
    });
    expect(err(bad).fields).toEqual([
      expect.objectContaining({
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
      }),
    ]);
    await call(w, 'POST', `/review-flags/${flagId}/clear`, {
      token: manager(),
      body: { reasonCode: 'resolved' },
    }).expect(204);
    const gone = await call(w, 'POST', `/review-flags/${flagId}/clear`, {
      token: manager(),
      body: { reasonCode: 'resolved' },
    });
    expect(err(gone).code).toBe('REVIEW_FLAG_NOT_FOUND');
  });

  it('separation, then the end of the household', async () => {
    const hm = await home();
    const tagged = await call(w, 'POST', `/units/${hm.unitId}/separation`, {
      token: manager(),
      body: { reasonCode: 'separation', reason: 'Private' },
    }).expect(201);
    expect(keyPaths(tagged.body)).toEqual(['flagId']);

    const missing = await call(w, 'POST', `/units/${hm.unitId}/end-household`, {
      token: manager(),
      body: {},
    });
    expect(err(missing).code).toBe('REASON_REQUIRED');
    await call(w, 'POST', `/units/${hm.unitId}/end-household`, {
      token: manager(),
      body: { reasonCode: 'household_left', reason: 'They left' },
    }).expect(204);
    const familyToken = await w.tokenFor(w.a, hm.family.id, 'family');
    await call(w, 'GET', `/units/${hm.unitId}`, { token: familyToken }).expect(
      401,
    );
  });

  it('transfer of ownership: the buyer becomes the primary', async () => {
    const hm = await home();
    const elsewhere = await w.helpers.unit(w.a);
    const buyer = await w.helpers.resident(w.a, [elsewhere.id]);
    const res = await call(
      w,
      'POST',
      `/units/${hm.unitId}/transfer-ownership`,
      {
        token: manager(),
        body: {
          toAccountId: buyer.id,
          reasonCode: 'unit_changed_hands',
          reason: 'Sold',
        },
      },
    ).expect(200);
    expect(keyPaths(res.body)).toEqual([
      'endReason',
      'endedAt',
      'handedOverAt',
      'id',
      'isPrimary',
      'occupancyType',
      'resides',
      'startedAt',
      'status',
      'unitCode',
      'unitId',
    ]);
    expect(res.body).toMatchObject({ isPrimary: true, occupancyType: 'owner' });
  });

  it('a new primary reviews the members whose permissions predate them', async () => {
    const hm = await home();
    const tenant = await w.helpers.resident(w.a, [hm.unitId], 'tenant');
    await call(w, 'POST', `/units/${hm.unitId}/primary`, {
      token: manager(),
      body: { accountId: tenant.id },
    }).expect(200);
    const token = await w.tokenFor(w.a, tenant.id, 'resident');

    const list = await call(
      w,
      'GET',
      `/units/${hm.unitId}/household/to-review`,
      {
        token,
      },
    ).expect(200);
    expect(keyPaths(list.body)).toEqual(
      listKeys(['fullName', 'isMinor', 'memberId', 'relation']),
    );
    expect(JSON.stringify(list.body)).not.toContain(hm.family.email);

    const done = await call(
      w,
      'POST',
      `/units/${hm.unitId}/household/reviewed`,
      {
        token,
        body: { all: true },
      },
    ).expect(200);
    expect(done.body).toEqual({ reviewed: 1 });
    const empty = await call(
      w,
      'GET',
      `/units/${hm.unitId}/household/to-review`,
      {
        token,
      },
    ).expect(200);
    expect(empty.body).toEqual({ data: [], nextCursor: null });
  });
});
