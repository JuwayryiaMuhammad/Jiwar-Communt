import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import {
  COMPOUND_EXPORT_BUILD_SWEEP,
  CompoundExportsService,
} from '../../src/core/reports/compound-exports.service';
import {
  REPORT_SCHEDULES_SWEEP,
  ReportSchedulesService,
} from '../../src/core/reports/report-schedules.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { sessionOf } from '../api/world';
import { auditReaders } from '../setup/audit';
import { M33_COVERAGE } from '../setup/audit-coverage-split';
import { budgetHelpers } from '../setup/budgets';
import { daysLater, today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-m33-secret';

/**
 * One scenario per entry of the reports platform's catalog (ADR 0014,
 * 0086): actor, target and metadata — keys, formats, periods, ids, years
 * and counts, never a figure of a report or a word of a line.
 */
const covered = new Set<string>();

describe('Audit coverage — the reports platform', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof budgetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    b = budgetHelpers(h);
    read = auditReaders(h);
    s = await b.setUp();
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    covered.add(action);
    return rows[0];
  }
  const http = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) => b.http(method, path, s.manager.token, body);

  describe('reports and schedules', () => {
    it('report.exported — the key, the format, the period; no figure', async () => {
      await http(
        'get',
        `/staff/reports/export?report=service_by_building&format=csv&from=${today()}&to=${today()}`,
      ).expect(200);
      expect(
        (await single('report.exported', s.c.tenantId)).metadata,
      ).toMatchObject({
        reportKey: 'service_by_building',
        format: 'csv',
        from: today(),
        to: today(),
        compare: 'none',
      });
    });

    it('report_schedule.created and .changed — the cadence, the format, whether it runs', async () => {
      const made = (
        await http('post', '/staff/report-schedules', {
          reportKey: 'energy_cost',
          cadence: 'weekly',
          format: 'xlsx',
        }).expect(201)
      ).body as { id: string };
      expect(
        (await single('report_schedule.created', made.id)).metadata,
      ).toEqual({
        reportKey: 'energy_cost',
        cadence: 'weekly',
        format: 'xlsx',
        compare: 'none',
        groupBy: 'building',
      });
      await http('patch', `/staff/report-schedules/${made.id}`, {
        active: false,
      }).expect(200);
      expect(
        (await single('report_schedule.changed', made.id)).metadata,
      ).toEqual({
        format: 'xlsx',
        compare: 'none',
        groupBy: 'building',
        active: false,
      });
    });

    it('report_run.written, .downloaded and .expired — the schedule, the key, the format', async () => {
      const schedule = await b.inTx(s.c, (tx) =>
        tx.reportSchedule.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            reportKey: 'service_by_building',
            cadence: 'daily',
            format: 'pdf',
            createdById: s.manager.id,
            createdAt: daysLater(-2),
          },
        }),
      );
      // As the sweep runs: no reader in the context, so a scheduled run
      // counts no sensitive ticket (ADR 0086).
      await h.moduleRef
        .get(SweepRunner)
        .run(REPORT_SCHEDULES_SWEEP, new Date());
      const run = await b.inTx(s.c, (tx) =>
        tx.reportRun.findFirstOrThrow({ where: { scheduleId: schedule.id } }),
      );
      const written = await single('report_run.written', run.id);
      expect(written.metadata).toMatchObject({
        scheduleId: schedule.id,
        reportKey: 'service_by_building',
        format: 'pdf',
      });
      await http('get', `/staff/report-runs/${run.id}/download`).expect(200);
      expect((await single('report_run.downloaded', run.id)).metadata).toEqual({
        reportKey: 'service_by_building',
      });
      await h.moduleRef.get(ReportSchedulesService).expireDue(daysLater(91));
      expect((await single('report_run.expired', run.id)).metadata).toEqual({});
    });
  });

  describe('the capital plan', () => {
    it('created, a line added and removed, submitted, returned, decided — the year, ids and amounts, never a line’s words', async () => {
      const year = Number(today().slice(0, 4)) + 1;
      const plan = (
        await http('post', '/maintenance/capital-plans', { year }).expect(201)
      ).body as { id: string };
      expect((await single('capital_plan.created', plan.id)).metadata).toEqual({
        year,
        seeded: 0,
      });
      const once = (
        await http('post', `/maintenance/capital-plans/${plan.id}/lines`, {
          description: `${MARKER} once`,
          amount: '10.00',
        }).expect(201)
      ).body as { lines: { id: string }[] };
      await http(
        'delete',
        `/maintenance/capital-plans/${plan.id}/lines/${once.lines[0].id}`,
      ).expect(200);
      expect(
        (await single('capital_plan.line_removed', plan.id)).metadata,
      ).toEqual({ lineId: once.lines[0].id, assetId: null, amount: '10.00' });
      await http('post', `/maintenance/capital-plans/${plan.id}/lines`, {
        description: `${MARKER} kept`,
        amount: '25.00',
      }).expect(201);
      const added = await read.tenant(s.c.tenantId, {
        action: 'capital_plan.line_added',
        targetId: plan.id,
      });
      expect(added).toHaveLength(2);
      expect(JSON.stringify(added)).not.toContain(MARKER);
      covered.add('capital_plan.line_added');
      const raise = () =>
        http('post', '/staff/governance/approvals', {
          type: 'capital_plan',
          capitalPlanId: plan.id,
          context: 'Next year’s works',
          impact: 'What the compound renews',
        }).expect(201);
      const first = (await raise()).body as { id: string };
      await http('post', `/staff/governance/approvals/${first.id}/withdraw`, {
        reasonCode: 'raised_in_error',
      }).expect((r) => expect([200, 201]).toContain(r.status));
      expect((await single('capital_plan.returned', plan.id)).metadata).toEqual(
        { requestId: first.id, year, reasonCode: 'withdrawn' },
      );
      const second = (await raise()).body as { id: string };
      const submitted = await read.tenant(s.c.tenantId, {
        action: 'capital_plan.submitted',
        targetId: plan.id,
      });
      expect(submitted.map((r) => r.metadata)).toEqual([
        { requestId: first.id, year, total: '25.00' },
        { requestId: second.id, year, total: '25.00' },
      ]);
      covered.add('capital_plan.submitted');
      await b.approve(s.owners.slice(0, 3), second.id);
      expect((await single('capital_plan.decided', plan.id)).metadata).toEqual({
        requestId: second.id,
        year,
        status: 'approved',
      });
    });
  });

  describe('the compound’s export', () => {
    it('requested, ready, downloaded and expired; a build that keeps failing is failed', async () => {
      await h.moduleRef.get(GlobalDbService).session.update({
        where: { id: sessionOf(s.manager.token) },
        data: { stepUpUntil: daysLater(1) },
      });
      const asked = (await http('post', '/staff/compound-exports').expect(201))
        .body as { id: string };
      expect(
        (await single('compound_export.requested', asked.id)).metadata,
      ).toEqual({ tables: 22 });
      const sweep = h.moduleRef.get(SweepRunner);
      while ((await sweep.run(COMPOUND_EXPORT_BUILD_SWEEP, new Date())) > 0);
      expect(
        (await single('compound_export.ready', asked.id)).metadata,
      ).toMatchObject({ attempts: 1, tables: 22 });
      await http('get', `/staff/compound-exports/${asked.id}/download`).expect(
        200,
      );
      expect(
        (await single('compound_export.downloaded', asked.id)).metadata,
      ).toEqual({});
      const exports = h.moduleRef.get(CompoundExportsService);
      await exports.expireDue(daysLater(8));
      expect(
        (await single('compound_export.expired', asked.id)).metadata,
      ).toEqual({});
      const doomed = newId();
      await b.inTx(s.c, (tx) =>
        tx.compoundExport.create({
          data: {
            id: doomed,
            tenantId: s.c.tenantId,
            requestedByAccountId: s.manager.id,
            requestedAt: daysLater(-3),
            attempts: 3,
          },
        }),
      );
      while ((await sweep.run(COMPOUND_EXPORT_BUILD_SWEEP, new Date())) > 0);
      expect((await single('compound_export.failed', doomed)).metadata).toEqual(
        { reasonCode: 'build_failed' },
      );
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the reports platform has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M33_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M33_COVERAGE].sort());
    });
  });
});
