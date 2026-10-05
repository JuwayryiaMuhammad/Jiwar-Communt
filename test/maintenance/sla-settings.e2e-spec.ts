import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0034: the SLA switch (off until the manager turns it on) and the
 * targets per category and priority (the defaults for every category,
 * new ones included).
 */
describe('Maintenance — SLA settings and targets', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

  const DEFAULTS = {
    emergency: { responseMinutes: 60, resolutionMinutes: 1440 },
    urgent: { responseMinutes: 240, resolutionMinutes: 4320 },
    normal: { responseMinutes: 1440, resolutionMinutes: 10080 },
  };

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
  }, 60_000);

  afterAll(() => h.close());

  type CategoryBody = { id: string; key: string; slaTargets: unknown };
  const categories = async () =>
    (
      (
        await d
          .http('get', '/maintenance/categories', s.manager.token)
          .expect(200)
      ).body as { data: CategoryBody[] }
    ).data;

  it('starts off, with no activation time', async () => {
    const res = await d
      .http('get', '/maintenance/sla-settings', s.manager.token)
      .expect(200);
    expect(res.body).toEqual({
      slaEnabled: false,
      enabledAt: null,
      updatedAt: expect.any(String) as string,
    });
  });

  it('only the manager reads or writes it; a supervisor is refused', async () => {
    await d
      .http('get', '/maintenance/sla-settings', s.supervisor.token)
      .expect(403);
    await d
      .http('patch', '/maintenance/sla-settings', s.supervisor.token, {
        slaEnabled: true,
      })
      .expect(403);
  });

  it('turning it on records when, by the database clock; turning it off keeps that time', async () => {
    const before = Date.now();
    const on = await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    const body = on.body as { slaEnabled: boolean; enabledAt: string };
    expect(body.slaEnabled).toBe(true);
    // The database's clock and the test's agree to within a few seconds.
    expect(Math.abs(new Date(body.enabledAt).getTime() - before)).toBeLessThan(
      10_000,
    );
    // On again: nothing changes, not even the time.
    const again = await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    expect((again.body as { enabledAt: string }).enabledAt).toBe(
      body.enabledAt,
    );
    const off = await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: false,
      })
      .expect(200);
    expect(off.body).toMatchObject({
      slaEnabled: false,
      enabledAt: body.enabledAt,
    });
  });

  it('every category shows the default targets', async () => {
    for (const c of await categories()) expect(c.slaTargets).toEqual(DEFAULTS);
  });

  it('a new category starts with the default targets', async () => {
    const created = await d
      .http('post', '/maintenance/categories', s.manager.token, {
        key: 'pool',
        nameAr: 'مسبح',
        nameEn: 'Pool',
      })
      .expect(201);
    expect((created.body as CategoryBody).slaTargets).toEqual(DEFAULTS);
    const rows = await d.inTenant(s.c, (tx) =>
      tx.slaTarget.count({
        where: { categoryId: (created.body as CategoryBody).id },
      }),
    );
    expect(rows).toBe(3);
  });

  it('the manager replaces a category’s three targets', async () => {
    const id = await d.categoryId(s.c, 'plumbing');
    const set = {
      emergency: { responseMinutes: 30, resolutionMinutes: 600 },
      urgent: { responseMinutes: 120, resolutionMinutes: 2880 },
      normal: { responseMinutes: 720, resolutionMinutes: 7200 },
    };
    await d
      .http(
        'put',
        `/maintenance/categories/${id}/sla-targets`,
        s.manager.token,
        set,
      )
      .expect(204);
    const plumbing = (await categories()).find((c) => c.id === id)!;
    expect(plumbing.slaTargets).toEqual(set);
    // The others keep theirs.
    const ac = (await categories()).find((c) => c.key === 'ac')!;
    expect(ac.slaTargets).toEqual(DEFAULTS);
  });

  it('refuses a response target longer than the resolution target, and a partial set', async () => {
    const id = await d.categoryId(s.c, 'ac');
    const res = await d
      .http(
        'put',
        `/maintenance/categories/${id}/sla-targets`,
        s.manager.token,
        {
          ...DEFAULTS,
          normal: { responseMinutes: 2000, resolutionMinutes: 1000 },
        },
      )
      .expect(400);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      {
        field: 'normal.responseMinutes',
        code: 'SLA_RESPONSE_AFTER_RESOLUTION',
      },
    ]);
    const partial = await d
      .http(
        'put',
        `/maintenance/categories/${id}/sla-targets`,
        s.manager.token,
        {
          emergency: DEFAULTS.emergency,
          urgent: DEFAULTS.urgent,
        },
      )
      .expect(400);
    expect((partial.body as { fields: unknown[] }).fields).toEqual([
      { field: 'normal', code: 'FIELD_REQUIRED' },
    ]);
    const ac = (await categories()).find((c) => c.id === id)!;
    expect(ac.slaTargets).toEqual(DEFAULTS);
  });

  it('a supervisor may not set targets', async () => {
    const id = await d.categoryId(s.c, 'ac');
    await d
      .http(
        'put',
        `/maintenance/categories/${id}/sla-targets`,
        s.supervisor.token,
        DEFAULTS,
      )
      .expect(403);
  });
});
