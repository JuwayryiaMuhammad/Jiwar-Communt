import { newId } from '../../src/core/common/uuid';
import { ReportSchedulesService } from '../../src/core/reports/report-schedules.service';
import { err } from '../api/request';
import { dbClock, daysLater, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface RunBody {
  id: string;
  scheduleId: string;
  reportKey: string;
  periodFrom: string;
  periodTo: string;
  format: string;
  status: string;
}

/**
 * ADR 0086: a report sent on a cadence — made by a holder of
 * `reports.schedule` who may read it; a run written once per period, two
 * sweeps meeting included; its readers told with the report's key and
 * period only; the file downloaded through the files service by whoever
 * holds the report's permission, and expired after 90 days.
 */
describe('Reports — schedules and their runs', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let s: OperationsSetUp;
  let svc: ReportSchedulesService;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    s = await o.setUp(1);
    svc = h.moduleRef.get(ReportSchedulesService);
  }, 120_000);

  afterAll(() => h.close());

  /** A daily schedule made two days ago, so yesterday's run is due. */
  const schedule = (over: Record<string, unknown> = {}) =>
    o.inTenant(s.c, (tx) =>
      tx.reportSchedule.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          reportKey: 'maintenance_spend',
          cadence: 'daily',
          format: 'csv',
          compare: 'previous',
          groupBy: 'building',
          createdById: s.manager.id,
          createdAt: daysLater(-2),
          ...over,
        },
      }),
    );
  const sweep = () => o.inTenant(s.c, (tx) => svc.runIn(tx, s.c.tenantId));
  const runsOf = (scheduleId: string) =>
    o.inTenant(s.c, (tx) => tx.reportRun.findMany({ where: { scheduleId } }));
  const notices = (accountId: string, runId: string) =>
    o.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId, kind: 'report_run.ready', targetId: runId },
      }),
    );

  it('is made by a holder of reports.schedule who may read the report; the grouping is the report’s', async () => {
    const made = await o
      .http('post', '/staff/report-schedules', s.manager.token, {
        reportKey: 'energy_cost',
        cadence: 'monthly',
        format: 'pdf',
        compare: 'last_year',
      })
      .expect(201);
    expect(made.body).toMatchObject({
      reportKey: 'energy_cost',
      cadence: 'monthly',
      format: 'pdf',
      compare: 'last_year',
      groupBy: 'building',
      active: true,
    });
    expect(
      err(
        await o
          .http('post', '/staff/report-schedules', s.manager.token, {
            reportKey: 'maintenance_spend',
            cadence: 'weekly',
            format: 'xlsx',
            groupBy: 'unit',
          })
          .expect(400),
      ).fields[0],
    ).toMatchObject({ field: 'groupBy', code: 'INVALID_VALUE' });
    await o
      .http('post', '/staff/report-schedules', s.supervisor.token, {
        reportKey: 'maintenance_spend',
        cadence: 'weekly',
        format: 'xlsx',
      })
      .expect(403);
    const paused = await o
      .http(
        'patch',
        `/staff/report-schedules/${(made.body as { id: string }).id}`,
        s.manager.token,
        { active: false, format: 'xlsx' },
      )
      .expect(200);
    expect(paused.body).toMatchObject({ active: false, format: 'xlsx' });
  });

  it('writes yesterday’s run once, tells the report’s readers with its key and period only, and the file downloads', async () => {
    const sch = await schedule();
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    const [run] = await runsOf(sch.id);
    expect(run).toMatchObject({
      reportKey: 'maintenance_spend',
      status: 'ready',
      format: 'csv',
    });
    expect(run.periodFrom.toISOString().slice(0, 10)).toBe(day(-1));
    // Again: the period has its run; nothing more is written or told.
    await sweep();
    expect(await runsOf(sch.id)).toHaveLength(1);
    const told = await notices(s.manager.id, run.id);
    expect(told).toHaveLength(1);
    expect(told[0].params).toEqual({
      reportKey: 'maintenance_spend',
      periodFrom: day(-1),
      periodTo: day(-1),
    });
    // A technician does not hold assets.manage: not told, not theirs.
    expect(await notices(s.techs[0].id, run.id)).toHaveLength(0);
    const listed = (
      await o.http('get', '/staff/report-runs', s.manager.token).expect(200)
    ).body as { data: RunBody[] };
    expect(listed.data.map((r) => r.id)).toContain(run.id);
    const link = (
      await o
        .http('get', `/staff/report-runs/${run.id}/download`, s.manager.token)
        .expect(200)
    ).body as { url: string };
    const file = await fetch(link.url);
    expect(file.ok).toBe(true);
    expect((await file.text()).split('\r\n')[0]).toContain(
      'Building,Tickets,Tickets (period before)',
    );
    // Not a holder of the report's permission: refused, or not found to them.
    await o
      .http('get', `/staff/report-runs/${run.id}/download`, s.techs[0].token)
      .expect((r) => expect([403, 404]).toContain(r.status));
    const file404 = await o
      .http('get', `/staff/report-runs/${newId()}/download`, s.manager.token)
      .expect(404);
    expect(err(file404).code).toBe('REPORT_RUN_NOT_FOUND');
  });

  it('two sweeps at once write one run and tell once', async () => {
    const sch = await schedule({ format: 'xlsx' });
    const done = await Promise.all([sweep(), sweep(), sweep()]);
    expect(done.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    const runs = await runsOf(sch.id);
    expect(runs).toHaveLength(1);
    expect(await notices(s.manager.id, runs[0].id)).toHaveLength(1);
    // One file for the one run: no orphan of the losers.
    const files = await o.inTenant(s.c, (tx) =>
      tx.storedFile.count({
        where: { purpose: 'report_file', id: runs[0].fileId! },
      }),
    );
    expect(files).toBe(1);
  });

  it('a paused schedule, or one made today, sends nothing for yesterday', async () => {
    const paused = await schedule({ active: false });
    const fresh = await schedule({ createdAt: dbClock() });
    await sweep();
    expect(await runsOf(paused.id)).toHaveLength(0);
    expect(await runsOf(fresh.id)).toHaveLength(0);
  });

  it('a run expires after its 90 days: no file, never downloadable again', async () => {
    const sch = await schedule({ format: 'pdf' });
    await sweep();
    const [run] = await runsOf(sch.id);
    await svc.expireDue(daysLater(91));
    const [gone] = await runsOf(sch.id);
    expect(gone).toMatchObject({ status: 'expired', fileId: null });
    const file = await o.inTenant(s.c, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: run.fileId! } }),
    );
    expect(file.deletedAt).not.toBeNull();
    await o
      .http('get', `/staff/report-runs/${run.id}/download`, s.manager.token)
      .expect(404);
  });
});
