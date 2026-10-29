import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { CONTRACT_SWEEP } from '../../src/maintenance/contracts/contract-sweep';
import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface Contract {
  id: string;
  code: string;
  status: string;
  endsOn: string;
  assetIds: string[];
  terminationReason: string | null;
}

/**
 * ADR 0065: the compound's maintenance contracts — dated, valued, covering
 * assets, their status read from the compound's day, terminated once, and
 * their end announced once per end date.
 */
describe('Operations — maintenance contracts', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let s: OperationsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    s = await o.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const create = (body: object = {}) =>
    o.http('post', '/maintenance/contracts', s.manager.token, {
      code: `AMC-${uniqueSuffix()}`,
      kind: 'amc',
      vendorName: 'Lift Co.',
      vendorPhone: '+20 2 1234 5678',
      startsOn: day(-30),
      endsOn: day(300),
      annualValue: '120000',
      ...body,
    });
  const contract = async (body: object = {}) =>
    (await create(body).expect(201)).body as Contract;

  it('its status is read from the compound’s day; the dates must be real and in order', async () => {
    expect((await contract()).status).toBe('active');
    expect(
      (await contract({ startsOn: day(10), endsOn: day(40) })).status,
    ).toBe('upcoming');
    expect(
      (await contract({ startsOn: day(-40), endsOn: day(-1) })).status,
    ).toBe('ended');
    expect(
      err(await create({ startsOn: day(5), endsOn: day(5) }).expect(400))
        .fields,
    ).toEqual([{ field: 'endsOn', code: 'ENDS_BEFORE_START' }]);
    expect(
      err(
        await create({ startsOn: '2026-02-30', endsOn: '2027-02-28' }).expect(
          400,
        ),
      ).fields,
    ).toEqual([{ field: 'startsOn', code: 'INVALID_FORMAT' }]);
    const taken = await contract();
    expect(err(await create({ code: taken.code }).expect(409))).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
    });
    const active = (
      await o
        .http(
          'get',
          '/maintenance/contracts?status=active&limit=100',
          s.manager.token,
        )
        .expect(200)
    ).body as { data: Contract[] };
    expect(active.data.every((c) => c.status === 'active')).toBe(true);
    await o.http('get', '/maintenance/contracts', s.techs[0].token).expect(403);
  });

  it('the assets it covers are replaced whole; a retired one is refused; a technician sees who to call, no money', async () => {
    const c = await contract();
    const [a1, a2, gone] = [
      await o.asset(s),
      await o.asset(s),
      await o.asset(s),
    ];
    await o
      .http('post', `/maintenance/assets/${gone}/retire`, s.manager.token, {
        reasonCode: 'disposed',
      })
      .expect((r) => expect(r.status).toBeLessThan(300));
    const set = (assetIds: string[]) =>
      o.http('put', `/maintenance/contracts/${c.id}/assets`, s.manager.token, {
        assetIds,
      });
    expect(err(await set([a1, gone]).expect(400)).fields).toEqual([
      { field: 'assetIds.1', code: 'ASSET_NOT_AVAILABLE' },
    ]);
    expect(
      ((await set([a1, a2]).expect(200)).body as Contract).assetIds,
    ).toEqual([a1, a2].sort());
    expect(((await set([a2]).expect(200)).body as Contract).assetIds).toEqual([
      a2,
    ]);
    const covering = (
      await o
        .http('get', `/maintenance/assets/${a2}/contracts`, s.techs[0].token)
        .expect(200)
    ).body as { data: Record<string, unknown>[] };
    expect(covering.data.map((x) => x.id)).toEqual([c.id]);
    expect(covering.data[0]).not.toHaveProperty('annualValue');
    expect(
      (
        (
          await o
            .http(
              'get',
              `/maintenance/assets/${a1}/contracts`,
              s.techs[0].token,
            )
            .expect(200)
        ).body as { data: unknown[] }
      ).data,
    ).toEqual([]);
  });

  it('terminated once with a reason, then never changed; a terminate racing an update leaves one consistent row', async () => {
    const c = await contract();
    const term = (reasonCode?: string) =>
      o.http(
        'post',
        `/maintenance/contracts/${c.id}/terminate`,
        s.manager.token,
        {
          ...(reasonCode ? { reasonCode } : {}),
        },
      );
    expect(err(await term().expect(400)).code).toBe('REASON_REQUIRED');
    const done = (await term('vendor_performance').expect(200))
      .body as Contract;
    expect(done).toMatchObject({
      status: 'terminated',
      terminationReason: 'vendor_performance',
    });
    expect(err(await term('budget').expect(409)).code).toBe(
      'MAINTENANCE_CONTRACT_TERMINATED',
    );
    expect(
      err(
        await o
          .http('patch', `/maintenance/contracts/${c.id}`, s.manager.token, {
            noticeDays: 5,
          })
          .expect(409),
      ).code,
    ).toBe('MAINTENANCE_CONTRACT_TERMINATED');
    await expect(
      o.inTenant(s.c, (tx) =>
        tx.maintenanceContract.update({
          where: { id: c.id },
          data: { terminationReason: 'other' },
        }),
      ),
    ).rejects.toThrow(/terminated contract never changes/);

    for (let round = 0; round < 3; round++) {
      const r = await contract();
      const results = await Promise.all([
        o.http(
          'post',
          `/maintenance/contracts/${r.id}/terminate`,
          s.manager.token,
          {
            reasonCode: 'replaced',
          },
        ),
        o.http('patch', `/maintenance/contracts/${r.id}`, s.supervisor.token, {
          endsOn: day(400),
        }),
      ]);
      const row = await o.inTenant(s.c, (tx) =>
        tx.maintenanceContract.findUniqueOrThrow({ where: { id: r.id } }),
      );
      expect(row.terminatedAt).not.toBeNull();
      // The update either came first (and stands) or was refused.
      expect([200, 409]).toContain(results[1].status);
    }
  });

  it('its papers are documents of it', async () => {
    const c = await contract();
    const files = fileHelpers(h);
    const fileId = await files.ready(
      s.manager.token,
      'asset_document',
      'application/pdf',
    );
    await o
      .http('post', '/maintenance/documents', s.manager.token, {
        contractId: c.id,
        fileId,
        kind: 'certificate',
        title: 'Signed AMC',
      })
      .expect(201);
    const listed = (
      await o
        .http(
          'get',
          `/maintenance/documents?contractId=${c.id}`,
          s.techs[0].token,
        )
        .expect(200)
    ).body as { data: { contractId: string; title: string }[] };
    expect(listed.data).toEqual([
      expect.objectContaining({
        contractId: c.id,
        title: 'Signed AMC',
      }) as unknown,
    ]);
  });

  it('its end is announced once per end date, within its notice days; never a terminated one', async () => {
    const sweep = () =>
      h.moduleRef.get(SweepRunner).run(CONTRACT_SWEEP, new Date());
    const notices = (id: string) =>
      o.inTenant(s.c, (tx) =>
        tx.notification.count({
          where: {
            accountId: s.manager.id,
            kind: 'maintenance_contract.expiring',
            targetId: id,
          },
        }),
      );
    const soon = await contract({ endsOn: day(10), noticeDays: 30 });
    const later = await contract({ endsOn: day(90), noticeDays: 30 });
    const dropped = await contract({ endsOn: day(5), noticeDays: 30 });
    await o
      .http(
        'post',
        `/maintenance/contracts/${dropped.id}/terminate`,
        s.manager.token,
        {
          reasonCode: 'not_needed',
        },
      )
      .expect(200);
    await sweep();
    await sweep();
    expect(await notices(soon.id)).toBe(1);
    expect(await notices(later.id)).toBe(0);
    expect(await notices(dropped.id)).toBe(0);
    await o
      .http('patch', `/maintenance/contracts/${soon.id}`, s.manager.token, {
        endsOn: day(20),
      })
      .expect(200);
    await sweep();
    expect(await notices(soon.id)).toBe(2);
  });
});
