import { CONTRACT_EXPIRY_SWEEP } from '../../src/community/contracts/contracts.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { communityHelpers } from '../setup/community';
import { day } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type Who } from '../setup/permits';

interface ContractBody {
  id: string;
  reference: string;
  status: string;
  noticeBy: string | null;
  code?: string;
}

/** A unit's contracts and lease renewals (ADR 0062). */
describe('Unit contracts', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let x: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    x = communityHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const codeOf = (res: { body: unknown }) => (res.body as ContractBody).code;

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who,
    body?: object,
  ) =>
    h
      .http()
      [method](`${API}${path}`)
      .set('Authorization', `Bearer ${who.token}`)
      .send(body);

  /** An owner (alice, primary) and a tenant of the same unit; their occupancies. */
  async function rented(name: string) {
    const s = await p.setUp(name);
    const t = await x.resident(s.c, [s.home.id], 'tenant');
    const tenant = await p.who(s.c, t.id, 'resident');
    const occupancies = await x.occupancies(s.c, s.home.id);
    const of = (accountId: string) =>
      occupancies.find(
        (o) => o.accountId === accountId && o.status === 'active',
      )!.id;
    return { ...s, tenant, aliceOcc: of(s.alice.id), tenantOcc: of(tenant.id) };
  }

  async function record(s: Awaited<ReturnType<typeof rented>>, body: object) {
    const fileId = await fileHelpers(h).ready(
      s.manager.token,
      'contract',
      'application/pdf',
    );
    return http('post', `/staff/units/${s.home.id}/contracts`, s.manager, {
      signedOn: day(-30),
      startsOn: day(-30),
      fileId,
      ...body,
    });
  }

  it('who sees which: the parties, and the owners the leases; never a tenant the deed', async () => {
    const s = await rented('Contracts Court');
    const lease = await record(s, {
      kind: 'lease',
      partyOccupancyIds: [s.tenantOcc],
      endsOn: day(335),
      noticeDays: 60,
    });
    expect(lease.status).toBe(201);
    const deed = await record(s, {
      kind: 'ownership',
      partyOccupancyIds: [s.aliceOcc],
    });
    expect(deed.status).toBe(201);
    // A lease binds tenants; a deed owners.
    expect(
      codeOf(
        await record(s, {
          kind: 'ownership',
          partyOccupancyIds: [s.tenantOcc],
        }),
      ),
    ).toBe('CONTRACT_PARTY_INVALID');
    // One live lease per tenant occupancy.
    expect(
      codeOf(
        await record(s, {
          kind: 'lease',
          partyOccupancyIds: [s.tenantOcc],
          endsOn: day(700),
          noticeDays: 30,
        }),
      ),
    ).toBe('CONTRACT_LEASE_LIVE');

    const refs = async (who: Who) =>
      ((await http('get', '/me/contracts', who)).body as ContractBody[])
        .map((c) => c.id)
        .sort();
    const leaseId = (lease.body as ContractBody).id;
    const deedId = (deed.body as ContractBody).id;
    expect(await refs(s.tenant)).toEqual([leaseId]);
    expect(await refs(s.alice)).toEqual([leaseId, deedId].sort());
    await http(
      'get',
      `/units/${s.home.id}/contracts/${deedId}`,
      s.tenant,
    ).expect(404);
    const opened = await http(
      'get',
      `/units/${s.home.id}/contracts/${leaseId}`,
      s.tenant,
    ).expect(200);
    expect(opened.headers['cache-control']).toBe('no-store');
    expect((opened.body as { fileUrl: string }).fileUrl).toMatch(/^http/);
  });

  it('end options, a renewal asked and renewed by the next lease; a second request refused', async () => {
    const s = await rented('Contracts Renewal Court');
    const lease = (
      await record(s, {
        kind: 'lease',
        partyOccupancyIds: [s.tenantOcc],
        endsOn: day(40),
        noticeDays: 60,
      })
    ).body as ContractBody;
    const options = (
      await http(
        'get',
        `/units/${s.home.id}/contracts/${lease.id}/end-options`,
        s.tenant,
      ).expect(200)
    ).body as { renewal: { askBy: string }; moveOut: { leaveBy: string } };
    expect(options).toMatchObject({
      renewal: { askBy: day(-20) },
      moveOut: { leaveBy: day(40) },
    });
    // The owner may read the options, not ask.
    expect(
      codeOf(
        await http(
          'post',
          `/units/${s.home.id}/contracts/${lease.id}/renewal-requests`,
          s.alice,
        ),
      ),
    ).toBe('CONTRACT_RENEWAL_NOT_ALLOWED');
    const asked = await http(
      'post',
      `/units/${s.home.id}/contracts/${lease.id}/renewal-requests`,
      s.tenant,
    ).expect(201);
    expect(
      codeOf(
        await http(
          'post',
          `/units/${s.home.id}/contracts/${lease.id}/renewal-requests`,
          s.tenant,
        ),
      ),
    ).toBe('CONTRACT_RENEWAL_OPEN');
    const next = await record(s, {
      kind: 'lease',
      partyOccupancyIds: [s.tenantOcc],
      startsOn: day(41),
      endsOn: day(406),
      noticeDays: 60,
      renewsId: lease.id,
      renewalRequestId: (asked.body as { id: string }).id,
    });
    expect(next.status).toBe(201);
    const mine = (await http('get', '/me/contracts', s.tenant))
      .body as ContractBody[];
    expect(mine.find((c) => c.id === lease.id)?.status).toBe('renewed');
    const told = await x.asManager(s.c, () =>
      x.prisma.tenant.notification.findFirst({
        where: { accountId: s.tenant.id, kind: 'contract.renewal_decided' },
      }),
    );
    expect(told?.params).toEqual({ outcome: 'renewed' });
  });

  it('the notice date tells the tenants and the owners, once', async () => {
    const s = await rented('Contracts Notice Court');
    await record(s, {
      kind: 'lease',
      partyOccupancyIds: [s.tenantOcc],
      endsOn: day(30),
      noticeDays: 60,
    });
    const sweep = h.moduleRef.get(SweepRunner);
    await sweep.run(CONTRACT_EXPIRY_SWEEP, new Date());
    await sweep.run(CONTRACT_EXPIRY_SWEEP, new Date());
    const told = await x.asManager(s.c, () =>
      x.prisma.tenant.notification.findMany({
        where: {
          kind: 'contract.expiring',
          accountId: { in: [s.alice.id, s.tenant.id] },
        },
      }),
    );
    expect(told.map((n) => n.accountId).sort()).toEqual(
      [s.alice.id, s.tenant.id].sort(),
    );
  });

  /** A tenant's lease, ending within its notice window, and its id. */
  async function leaseInWindow(s: Awaited<ReturnType<typeof rented>>) {
    return (
      (
        await record(s, {
          kind: 'lease',
          partyOccupancyIds: [s.tenantOcc],
          endsOn: day(40),
          noticeDays: 60,
        })
      ).body as ContractBody
    ).id;
  }

  const askRenewal = (s: Awaited<ReturnType<typeof rented>>, id: string) =>
    http(
      'post',
      `/units/${s.home.id}/contracts/${id}/renewal-requests`,
      s.tenant,
    );

  it('a void waits for the open renewal request: declined first, the tenant told', async () => {
    const s = await rented('Contracts Void Court');
    const id = await leaseInWindow(s);
    const asked = (await askRenewal(s, id)).body as { id: string };
    const refused = await http(
      'post',
      `/staff/contracts/${id}/void`,
      s.manager,
      {
        reasonCode: 'data_error',
      },
    );
    expect([refused.status, codeOf(refused)]).toEqual([
      409,
      'CONTRACT_RENEWAL_OPEN',
    ]);
    await http(
      'post',
      `/staff/contract-renewals/${asked.id}/decline`,
      s.manager,
      {
        reasonCode: 'other',
      },
    ).expect(200);
    await http('post', `/staff/contracts/${id}/void`, s.manager, {
      reasonCode: 'data_error',
    }).expect(200);
  });

  it('race: a renewal request against a void — never an open request on a voided lease', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await rented(`Contracts Void Race ${i}`);
      const id = await leaseInWindow(s);
      const [asked, voided] = await Promise.all([
        askRenewal(s, id),
        http('post', `/staff/contracts/${id}/void`, s.manager, {
          reasonCode: 'data_error',
        }),
      ]);
      // Either order is allowed; both together never are.
      expect(
        [asked.status === 201, voided.status === 200].filter(Boolean),
      ).toHaveLength(1);
      if (asked.status !== 201) expect(codeOf(asked)).toBe('CONTRACT_NOT_LIVE');
      if (voided.status !== 200)
        expect(codeOf(voided)).toBe('CONTRACT_RENEWAL_OPEN');
      const [contract, open] = await x.asManager(s.c, () =>
        Promise.all([
          x.prisma.tenant.unitContract.findUniqueOrThrow({ where: { id } }),
          x.prisma.tenant.contractRenewal.count({
            where: { contractId: id, status: 'open' },
          }),
        ]),
      );
      expect(contract.voidedAt !== null && open > 0).toBe(false);
    }
  });

  it('race: two renewal requests at once — one is open', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await rented(`Contracts Twice Race ${i}`);
      const id = await leaseInWindow(s);
      const both = await Promise.all([askRenewal(s, id), askRenewal(s, id)]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(both.map(codeOf).filter(Boolean)).toEqual([
        'CONTRACT_RENEWAL_OPEN',
      ]);
      expect(
        await x.asManager(s.c, () =>
          x.prisma.tenant.contractRenewal.count({ where: { contractId: id } }),
        ),
      ).toBe(1);
    }
  });

  it('race: a decline against the renewing lease — one closes the request', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await rented(`Contracts Race Court ${i}`);
      const lease = (
        await record(s, {
          kind: 'lease',
          partyOccupancyIds: [s.tenantOcc],
          endsOn: day(40),
          noticeDays: 60,
        })
      ).body as ContractBody;
      const asked = (
        await http(
          'post',
          `/units/${s.home.id}/contracts/${lease.id}/renewal-requests`,
          s.tenant,
        )
      ).body as { id: string };
      const [declined, renewed] = await Promise.all([
        http(
          'post',
          `/staff/contract-renewals/${asked.id}/decline`,
          s.manager,
          {
            reasonCode: 'terms_not_agreed',
          },
        ),
        record(s, {
          kind: 'lease',
          partyOccupancyIds: [s.tenantOcc],
          startsOn: day(41),
          endsOn: day(406),
          noticeDays: 60,
          renewsId: lease.id,
          renewalRequestId: asked.id,
        }),
      ]);
      expect(
        [declined.status === 200, renewed.status === 201].filter(Boolean),
      ).toHaveLength(1);
      const row = await x.asManager(s.c, () =>
        x.prisma.tenant.contractRenewal.findUniqueOrThrow({
          where: { id: asked.id },
        }),
      );
      expect(row.status).toBe(declined.status === 200 ? 'declined' : 'renewed');
    }
  });
});
