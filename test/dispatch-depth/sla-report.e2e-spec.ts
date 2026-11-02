import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { addDays } from '../../src/maintenance/schedules/local-dates';
import { SLA_SWEEP, SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { today } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { rewind, slaClocks } from '../setup/sla';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

interface Report {
  totals: {
    clock: string;
    met: number;
    breached: number;
    metRate: number | null;
  }[];
  rows: {
    categoryKey: string;
    priority: string;
    clock: string;
    met: number;
    breached: number;
    metRate: number;
  }[];
}

/**
 * ADR 0076: whether the SLA was kept — the clocks that ended met or
 * breached on a period, by category, priority and clock, the share met,
 * and the totals; as JSON and CSV. A stopped clock is no verdict.
 */
describe('Dispatch depth — the SLA report', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    await d
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    // The pass opens a transaction a ticket at a time: the compound's
    // context only, never inside one (ADR 0034).
    const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    await cls.run(async () => {
      cls.set('tenantId', s.c.tenantId);
      await h.moduleRef.get(SlaSweep).pass();
    });
  }, 180_000);

  afterAll(() => h.close());

  async function assigned(): Promise<string> {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);
    return id;
  }

  const period = () => `from=${addDays(today(), -1)}&to=${today()}`;

  it('counts a met and a breached response by category and priority, with the share met', async () => {
    const met = await assigned();
    await d
      .http('post', `/technician/tickets/${met}/start`, s.techs[0].token)
      .expect(204);
    const late = await assigned();
    const response = (await slaClocks(late)).find(
      (c) => c.clock === 'response',
    )!;
    await rewind(late, response.targetMinutes + 5);
    await h.moduleRef.get(SweepRunner).run(SLA_SWEEP, new Date());
    const res = await d
      .http('get', `/maintenance/sla-report?${period()}`, s.supervisor.token)
      .expect(200);
    const body = res.body as Report;
    const t = await d.ticketRow(s.c, met);
    const row = body.rows.find(
      (r) => r.clock === 'response' && r.priority === t.priority,
    )!;
    expect(row).toMatchObject({ met: 1, breached: 1, metRate: 0.5 });
    expect(body.totals.find((t) => t.clock === 'response')).toMatchObject({
      met: 1,
      breached: 1,
      metRate: 0.5,
    });
  });

  it('as CSV, keys and counts only', async () => {
    const res = await d
      .http(
        'get',
        `/maintenance/sla-report/export?${period()}`,
        s.supervisor.token,
      )
      .buffer(true)
      .parse((r, done) => {
        let body = '';
        r.on('data', (c: Buffer) => (body += c.toString('utf8')));
        r.on('end', () => done(null, body));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect((res.body as string).split('\r\n')[0]).toContain(
      'category_key,priority,clock,met,breached,met_rate',
    );
  });

  it('is dispatch’s', async () => {
    await d
      .http('get', `/maintenance/sla-report?${period()}`, s.techs[0].token)
      .expect(403);
  });
});
