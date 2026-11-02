import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  SERVICE_PRESSURE_EVERY_MS,
  SERVICE_PRESSURE_SWEEP,
} from '../../src/maintenance/dispatch/service-pressure';
import { auditReaders } from '../setup/audit';
import { dbClock } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

interface Pressure {
  threshold: number | null;
  open: number;
  available: number;
  underPressure: boolean;
  since: string | null;
  toldAt: string | null;
}

const MINUTE = 60_000;

/**
 * ADR 0079: service pressure. A compound sets how many open tickets one
 * available technician may carry (off by default). At that many times the
 * available technicians the dispatch and the managers are told once a
 * rise; it eases silently; a rise within an hour of the last notice is
 * told when the hour is up. Two sweeps at once meet on the compound's row
 * and tell once.
 */
describe('Operations dashboard — service pressure', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    await d.setAvailability(s.c, s.techs[0].id, 'available');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const sweep = (now: Date) =>
    h.moduleRef.get(SweepRunner).run(SERVICE_PRESSURE_SWEEP, now);

  const state = async () =>
    (
      await d
        .http('get', '/maintenance/service-pressure', s.supervisor.token)
        .expect(200)
    ).body as Pressure;

  const set = (openPerTechnician: number | null) =>
    d
      .http('patch', '/maintenance/service-pressure', s.manager.token, {
        openPerTechnician,
      })
      .expect(200);

  const notices = () =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'maintenance.service_pressure' },
        select: { accountId: true, params: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

  it('runs every five minutes; off until a manager sets it', async () => {
    expect(
      h.moduleRef.get(SweepRunner).intervalOf(SERVICE_PRESSURE_SWEEP),
    ).toBe(SERVICE_PRESSURE_EVERY_MS);
    expect(await state()).toMatchObject({
      threshold: null,
      available: 1,
      underPressure: false,
      since: null,
    });
    await d.openTicket(s);
    await d.openTicket(s);
    await sweep(dbClock());
    expect(await notices()).toEqual([]);
  });

  it('the threshold is the managers’, 1 to 100, audited', async () => {
    for (const openPerTechnician of [0, 101, 2.5]) {
      const res = await d
        .http('patch', '/maintenance/service-pressure', s.manager.token, {
          openPerTechnician,
        })
        .expect(400);
      expect(
        (res.body as { fields: { field: string; code: string }[] }).fields[0],
      ).toMatchObject({
        field: 'openPerTechnician',
        code: 'INVALID_NUMBER',
      });
    }
    await d
      .http('patch', '/maintenance/service-pressure', s.supervisor.token, {
        openPerTechnician: 2,
      })
      .expect(403);
    const res = await set(2);
    expect(res.body).toMatchObject({
      threshold: 2,
      open: 2,
      underPressure: true,
    });
    const audit = await read.tenant(s.c.tenantId, {
      action: 'maintenance.service_pressure_changed',
    });
    expect(audit.map((a) => a.changes)).toEqual([
      { openPerTechnician: { from: null, to: 2 } },
    ]);
  });

  it('a rise is told once, to the dispatch and the managers, whatever the sweeps', async () => {
    const now = dbClock();
    // The sweep's count is every compound's: this compound's notices are what counts.
    await sweep(now);
    await sweep(new Date(now.getTime() + 5 * MINUTE));
    const told = await notices();
    expect(told.map((n) => n.accountId).sort()).toEqual(
      [s.manager.id, s.supervisor.id].sort(),
    );
    expect(told[0].params).toEqual({ open: 2, available: 1, threshold: 2 });
    expect(await state()).toMatchObject({ underPressure: true });
    expect((await state()).since).not.toBeNull();
  });

  it('eases silently; a new rise within the hour waits for the hour, then two sweeps at once tell once', async () => {
    const start = new Date((await state()).toldAt!);
    await set(3);
    await sweep(new Date(start.getTime() + 10 * MINUTE));
    expect((await state()).since).toBeNull();
    await set(2);
    await sweep(new Date(start.getTime() + 20 * MINUTE));
    expect((await notices()).length).toBe(2);
    expect((await state()).since).not.toBeNull();

    const late = new Date(start.getTime() + 61 * MINUTE);
    await Promise.all([sweep(late), sweep(late), sweep(late)]);
    expect((await notices()).length).toBe(4);
  });

  it('turned off, a rise in course ends and nothing is told', async () => {
    const res = await set(null);
    expect(res.body).toMatchObject({
      threshold: null,
      underPressure: false,
      since: null,
    });
    const before = (await notices()).length;
    await sweep(new Date(dbClock().getTime() + 3 * 60 * MINUTE));
    expect((await notices()).length).toBe(before);
  });

  it('shows on the dashboard: the maintenance card and the warning', async () => {
    await set(1);
    const summary = (
      await d.http('get', '/staff/dashboard', s.manager.token).expect(200)
    ).body as {
      figures: { maintenance: { pressure: Record<string, unknown> } };
    };
    expect(summary.figures.maintenance.pressure).toMatchObject({
      threshold: 1,
      available: 1,
      underPressure: true,
    });
    const n = (
      await d
        .http('get', '/staff/dashboard/needs-you', s.manager.token)
        .expect(200)
    ).body as { alerts: { code: string; severity: string }[] };
    expect(n.alerts).toContainEqual(
      expect.objectContaining({
        code: 'service_pressure',
        severity: 'warning',
      }),
    );
    // Left off, so no later pass of the sweep finds this compound pressed.
    await set(null);
  });
});
