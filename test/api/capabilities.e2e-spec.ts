import type { Response } from 'supertest';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { call, err } from './request';
import { minorBody } from './routes/household';
import { passBody } from './routes/visitors';
import { buildWorld, type World } from './world';

type Flags = Record<string, boolean | string | null>;

interface Probe {
  flag: string;
  /** What the flag allows, called as the persona on the unit. */
  run: (token: string, unitId: string) => Promise<Response>;
}

/**
 * Capabilities drive access (ADR 0020, 0025): what GET
 * /me/units/:unitId/capabilities says is what the endpoints do. For each
 * persona, every flag that has an endpoint is probed: allowed → 2xx,
 * disallowed → 403/404. Flags whose domains have no endpoint yet (finance,
 * governance, bookings…) are asserted on the flag only.
 */
describe('API v0 — capabilities drive access', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const PROBES: Probe[] = [
    {
      flag: 'unitView',
      run: (token, u) => call(w, 'GET', `/units/${u}`, { token }),
    },
    {
      flag: 'householdView',
      run: (token, u) => call(w, 'GET', `/units/${u}/household`, { token }),
    },
    {
      flag: 'householdView',
      run: (token, u) => call(w, 'GET', `/units/${u}/workers`, { token }),
    },
    {
      flag: 'householdManage',
      run: (token, u) =>
        call(w, 'POST', `/units/${u}/household/minors`, {
          token,
          body: minorBody(),
        }),
    },
    {
      // The gate (ADR 0028): a visitor pass is visitorsInvite, exactly.
      flag: 'visitorsInvite',
      run: (token, u) =>
        call(w, 'POST', `/units/${u}/visitor-passes`, {
          token,
          body: passBody(),
        }),
    },
    {
      // The resident's entry QR (ADR 0031): registering a phone needs
      // gateEntry on some unit (these personas live in one at most). The
      // probe revokes what it registers, so the limit never bites.
      flag: 'gateEntry',
      run: async (token) => {
        const res = await call(w, 'POST', '/me/entry-credentials', {
          token,
          body: {},
        });
        if (res.status === 201) {
          await call(
            w,
            'POST',
            `/me/entry-credentials/${(res.body as { id: string }).id}/revoke`,
            { token },
          ).expect(204);
        }
        return res;
      },
    },
  ];

  async function check(
    persona: string,
    token: string,
    unitId: string,
    expected: Flags,
  ) {
    const caps = await call(w, 'GET', `/me/units/${unitId}/capabilities`, {
      token,
    }).expect(200);
    const flags = caps.body as Flags;
    expect({ persona, ...pick(flags, Object.keys(expected)) }).toEqual({
      persona,
      ...expected,
    });
    for (const probe of PROBES) {
      const res = await probe.run(token, unitId);
      const outcome = { persona, flag: probe.flag, status: res.status };
      if (flags[probe.flag] === true) {
        expect(outcome).toEqual({
          ...outcome,
          status: expect.any(Number) as number,
        });
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
      } else {
        expect([403, 404]).toContain(res.status);
      }
    }
  }

  it('an owner-landlord: the unit and its money, never the household', async () => {
    await check('landlord', w.a.tokens.landlord, w.a.rentedUnitId, {
      unitView: true,
      householdView: false,
      householdManage: false,
      landlordTenantFinance: true,
      governanceVote: true,
      visitorsInvite: false,
      gateEntry: false,
    });
  });

  it('a tenant living there (the primary): the household, never ownership', async () => {
    await check('tenant', w.a.tokens.tenant, w.a.rentedUnitId, {
      unitView: true,
      householdView: true,
      householdManage: true,
      ownershipCard: true,
      transferOwnership: false,
      governanceVote: false,
      visitorsInvite: true,
      gateEntry: true,
    });
  });

  it('a family member without finance', async () => {
    await check('family', w.a.tokens.family, w.a.homeUnitId, {
      unitView: true,
      householdView: true,
      householdManage: false,
      financeView: false,
      financePay: false,
      bookings: true,
      visitorsInvite: true,
      gateEntry: true,
    });
  });

  it('a unit under a death review: finance stops, the household freezes (403)', async () => {
    const unit = await w.helpers.unit(w.a);
    const owner = await w.helpers.resident(w.a, [unit.id]);
    const family = await w.helpers.joinFamily(w.a, unit.id, owner);
    await call(w, 'POST', `/units/${unit.id}/deceased`, {
      token: w.a.tokens.manager,
      body: { reasonCode: 'deceased', reason: 'Condolences' },
    }).expect(201);

    const primaryToken = await w.tokenFor(w.a, owner.id, 'resident');
    const frozen = await call(w, 'POST', `/units/${unit.id}/household/minors`, {
      token: primaryToken,
      body: minorBody(),
    });
    expect({ status: frozen.status, code: err(frozen).code }).toEqual({
      status: 403,
      code: 'HOUSEHOLD_UNDER_REVIEW',
    });
    await check('deceasedPrimary', primaryToken, unit.id, {
      unitView: true,
      householdView: true,
      householdManage: false,
      financeView: false,
      financePay: false,
      // A death review takes nothing away from living at home (ADR 0031).
      gateEntry: true,
    });
    await check(
      'familyUnderReview',
      await w.tokenFor(w.a, family.id, 'family'),
      unit.id,
      {
        unitView: true,
        householdView: true,
        householdManage: false,
        financeView: false,
      },
    );
  });
});

function pick(o: Flags, keys: string[]): Flags {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
