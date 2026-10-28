import { PROXY_EXPIRY_SWEEP } from '../../src/community/proxies/proxies.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { communityHelpers } from '../setup/community';
import { day, daysLater } from '../setup/compound-clock';
import { nationalIdFor } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { permitHelpers, type Who } from '../setup/permits';

interface ProxyBody {
  id: string;
  status: string;
  name: string | null;
  endReason: string | null;
  code?: string;
}

/** Unit proxies, closed mode and the owner of a unit with no primary (ADR 0063). */
describe('Unit proxies and the closed unit', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let x: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    x = communityHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who | null,
    body?: object,
  ) => {
    const req = h.http()[method](`${API}${path}`);
    return (who ? req.set('Authorization', `Bearer ${who.token}`) : req).send(
      body,
    );
  };
  const codeOf = (res: { body: unknown }) => (res.body as ProxyBody).code;
  type SetUp = Awaited<ReturnType<typeof p.setUp>>;

  const person = () => ({
    fullName: 'Nadia Wakil',
    email: uniqueEmail('proxy'),
    phone: uniquePhone(),
    idDocumentType: 'national_id',
    idDocumentNumber: nationalIdFor(),
  });

  /** An owner appoints; the token and the person. */
  async function appoint(
    s: SetUp,
    scopes: string[],
    who: Who = s.alice,
    endsOn = day(60),
  ) {
    const body = { ...person(), scopes, endsOn };
    const res = await http('post', `/units/${s.home.id}/proxies`, who, body);
    return { res, email: body.email };
  }

  /** The person accepts with the emailed code. */
  async function accept(token: string, email: string): Promise<void> {
    const since = new Date();
    await http('post', '/proxy-invites/accept/start', null, { token }).expect(
      202,
    );
    const code = await waitForOtp(email, since);
    await http('post', '/proxy-invites/accept/complete', null, {
      token,
      code,
    }).expect(200);
  }

  /** The proxy's own token, as its account logs in. */
  async function asProxy(s: SetUp, email: string): Promise<Who> {
    const account = await x.asManager(s.c, () =>
      x.prisma.tenant.account.findFirstOrThrow({
        where: { type: 'proxy', email },
      }),
    );
    return {
      id: account.id,
      token: await h.tokenFor({
        sub: account.id,
        tid: s.c.tenantId,
        typ: 'proxy',
      }),
    };
  }

  const caps = async (s: SetUp, who: Who) =>
    (await http('get', `/me/units/${s.home.id}/capabilities`, who)).body as {
      unitView: boolean;
      tickets: boolean;
      visitorsInvite: boolean;
    };
  const closeUnit = (s: SetUp, closed: boolean, who: Who = s.alice) =>
    http('post', `/units/${s.home.id}/closed-mode`, who, { closed });

  it('an owner appoints, the person accepts with the emailed code; the proxy acts only while the unit is closed, with its scopes', async () => {
    const s = await p.setUp('Proxy Court');
    const { res, email } = await appoint(s, ['tickets', 'works']);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const created = res.body as { proxy: ProxyBody; token: string };
    expect(created.proxy).toMatchObject({
      status: 'invited',
      name: 'Nadia Wakil',
    });
    await accept(created.token, email);
    const proxy = await asProxy(s, email);
    const listed = (
      await http('get', `/units/${s.home.id}/proxies`, s.alice).expect(200)
    ).body as ProxyBody[];
    expect(listed[0]).toMatchObject({ status: 'active', name: 'Nadia Wakil' });
    // The invite's details went with the acceptance.
    const row = await x.asManager(s.c, () =>
      x.prisma.tenant.unitProxy.findUniqueOrThrow({
        where: { id: created.proxy.id },
      }),
    );
    expect([row.email, row.phone, row.idDocumentNumber]).toEqual([
      null,
      null,
      null,
    ]);

    // The unit is open with its primary: nothing.
    expect(await caps(s, proxy)).toMatchObject({
      unitView: false,
      tickets: false,
    });
    await closeUnit(s, true).expect(204);
    expect(await caps(s, proxy)).toMatchObject({
      unitView: true,
      tickets: true,
      visitorsInvite: false,
    });
    // A works permit, on behalf of the owner who appointed it.
    const permit = await p.works(proxy, s.home.id);
    expect(permit).toMatchObject({ kind: 'works' });
    // A move is not its to ask for.
    expect((await p.moveRaw(proxy, s.home.id)).status).toBe(403);
    // Reopened: nothing again.
    await closeUnit(s, false).expect(204);
    expect((await caps(s, proxy)).unitView).toBe(false);
  });

  it('only an owner appoints, two at most; a tenant never closes the unit', async () => {
    const s = await p.setUp('Proxy Rules Court');
    const t = await x.resident(s.c, [s.home.id], 'tenant');
    const tenant = await p.who(s.c, t.id, 'resident');
    expect(codeOf((await appoint(s, ['tickets'], tenant)).res)).toBe(
      'PROXY_NOT_ALLOWED',
    );
    expect(codeOf(await closeUnit(s, true, tenant))).toBe(
      'NOT_PRIMARY_RESIDENT',
    );
    expect((await appoint(s, ['tickets'])).res.status).toBe(201);
    expect((await appoint(s, ['requests'])).res.status).toBe(201);
    // The input is checked before the room for one more.
    expect((await appoint(s, ['tickets'], s.alice, day(400))).res.status).toBe(
      400,
    );
    expect(codeOf((await appoint(s, ['works'])).res)).toBe('PROXY_LIMIT');
    // A proxy's account comes only from its accepted invite.
    const made = await http('post', '/accounts', s.manager, {
      type: 'proxy',
      fullName: 'Made Proxy',
      phone: uniquePhone(),
    });
    expect(made.status).toBe(400);
    expect((made.body as { fields: unknown[] }).fields).toContainEqual(
      expect.objectContaining({ field: 'type', code: 'INVALID_VALUE' }),
    );
  });

  it('the owner of a unit with no primary closes it and asks for works', async () => {
    const s = await p.setUp('Proxy Vacant Court');
    const owner = await x.resident(s.c, [s.home.id], 'owner');
    const second = await p.who(s.c, owner.id, 'resident');
    // A primary lives there: only they close it.
    expect(codeOf(await closeUnit(s, true, second))).toBe(
      'NOT_PRIMARY_RESIDENT',
    );
    const primary = await x.asManager(s.c, () =>
      x.prisma.tenant.unitOccupancy.findFirstOrThrow({
        where: { unitId: s.home.id, isPrimary: true, status: 'active' },
      }),
    );
    await http('post', `/occupancies/${primary.id}/end`, s.manager, {
      reasonCode: 'moved_out',
      reason: 'Moved away',
    }).expect(200);
    await closeUnit(s, true, second).expect(204);
    const unit = await x.asManager(s.c, () =>
      x.prisma.tenant.unit.findUniqueOrThrow({ where: { id: s.home.id } }),
    );
    expect(unit.closedSince).not.toBeNull();
    expect(await p.works(second, s.home.id)).toMatchObject({ kind: 'works' });
  });

  it('a proxy ends with a revoke, the appointing owner leaving, a transfer and its end; closed mode ends with the household', async () => {
    const s = await p.setUp('Proxy End Court');
    const revoked = (await appoint(s, ['tickets'])).res.body as {
      proxy: ProxyBody;
    };
    const after = (
      await http(
        'post',
        `/units/${s.home.id}/proxies/${revoked.proxy.id}/revoke`,
        s.alice,
      ).expect(200)
    ).body as ProxyBody;
    expect(after).toMatchObject({ status: 'ended', endReason: 'revoked' });
    // The link died with it.
    expect(
      await h.moduleRef
        .get(GlobalDbService)
        .proxyInviteToken.count({ where: { proxyId: revoked.proxy.id } }),
    ).toBe(0);

    const expiring = (await appoint(s, ['tickets'], s.alice, day(2))).res
      .body as { proxy: ProxyBody; token: string };
    await h.moduleRef.get(SweepRunner).run(PROXY_EXPIRY_SWEEP, daysLater(8));
    const swept = await x.asManager(s.c, () =>
      x.prisma.tenant.unitProxy.findUniqueOrThrow({
        where: { id: expiring.proxy.id },
      }),
    );
    // Unanswered for seven days: the invite ended first.
    expect(swept).toMatchObject({
      status: 'ended',
      endReason: 'invite_expired',
      email: null,
    });

    await closeUnit(s, true).expect(204);
    const kept = (await appoint(s, ['tickets'])).res.body as {
      proxy: ProxyBody;
    };
    const buyer = await x.resident(s.c, [(await x.unit(s.c)).id]);
    await http('post', `/units/${s.home.id}/transfer-ownership`, s.manager, {
      toAccountId: buyer.id,
      reasonCode: 'unit_changed_hands',
      reason: 'Sold',
    }).expect(200);
    const [unit, ended] = await x.asManager(s.c, () =>
      Promise.all([
        x.prisma.tenant.unit.findUniqueOrThrow({ where: { id: s.home.id } }),
        x.prisma.tenant.unitProxy.findUniqueOrThrow({
          where: { id: kept.proxy.id },
        }),
      ]),
    );
    expect(unit.closedSince).toBeNull();
    expect(ended.status).toBe('ended');
    expect(['appointer_left', 'ownership_transferred']).toContain(
      ended.endReason,
    );
  });

  it('a proxy and its invite move forward only', async () => {
    const s = await p.setUp('Proxy Schema Court');
    const created = (await appoint(s, ['tickets'])).res.body as {
      proxy: ProxyBody;
    };
    const tx = <T>(fn: () => Promise<T>) => x.asManager(s.c, fn);
    await expect(
      tx(() =>
        x.prisma.tenant.unitProxy.update({
          where: { id: created.proxy.id },
          data: { scopes: ['tickets', 'works'] },
        }),
      ),
    ).rejects.toThrow(/unit_proxies/);
    await expect(
      tx(() =>
        x.prisma.tenant.unitProxy.delete({ where: { id: created.proxy.id } }),
      ),
    ).rejects.toThrow(/unit_proxies/);
  });

  it('race: two appointments for the last place — one is made', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await p.setUp(`Proxy Race Court ${i}`);
      expect((await appoint(s, ['tickets'])).res.status).toBe(201);
      const both = await Promise.all([
        appoint(s, ['requests']),
        appoint(s, ['works']),
      ]);
      expect(both.map((b) => b.res.status).sort()).toEqual([201, 409]);
      const live = await x.asManager(s.c, () =>
        x.prisma.tenant.unitProxy.count({
          where: { unitId: s.home.id, status: { in: ['invited', 'active'] } },
        }),
      );
      expect(live).toBe(2);
    }
  });

  it('race: an acceptance against a revoke — never active once revoked', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await p.setUp(`Proxy Accept Race ${i}`);
      const { res, email } = await appoint(s, ['tickets']);
      const created = res.body as { proxy: ProxyBody; token: string };
      const since = new Date();
      await http('post', '/proxy-invites/accept/start', null, {
        token: created.token,
      }).expect(202);
      const code = await waitForOtp(email, since);
      const [accepted, revoked] = await Promise.all([
        http('post', '/proxy-invites/accept/complete', null, {
          token: created.token,
          code,
        }),
        http(
          'post',
          `/units/${s.home.id}/proxies/${created.proxy.id}/revoke`,
          s.alice,
        ),
      ]);
      const row = await x.asManager(s.c, () =>
        x.prisma.tenant.unitProxy.findUniqueOrThrow({
          where: { id: created.proxy.id },
        }),
      );
      // Whichever came first, the other found it decided; it ends ended.
      expect([200, 401]).toContain(accepted.status);
      expect(revoked.status).toBe(200);
      expect(row.status).toBe('ended');
    }
  });
});
