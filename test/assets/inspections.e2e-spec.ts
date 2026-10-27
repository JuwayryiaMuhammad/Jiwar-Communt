import { err } from '../api/request';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { INSPECTION_SWEEP } from '../../src/maintenance/inspections/inspection-sweep';
import { parseCsv } from '../../src/core/common/csv-parse';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { dbDate, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type View = {
  id: string;
  status: string;
  dueOn: string;
  scannedAt: string | null;
  checklist: {
    items: { id: string }[];
    status: string;
    attestationSha256: string | null;
  };
  findings: { itemId: string; ticketId: string; ticketStatus: string }[];
};

/**
 * ADR 0064: field inspections. A round opens one inspection per due date
 * within its lead, however often its sweep runs; the inspector starts it,
 * scans the place's tag when the checklist asks (an old print or another
 * place's is refused), answers and submits once; each failing item that
 * asks for one opens a follow-up work order, once, for the area or the
 * asset; past its day the inspector and who manages them hear once. The
 * report counts what was done and followed up, and its CSV is defused.
 */
describe('Assets — inspections', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let inspector: { id: string; token: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    inspector = s.techs[0];
  }, 90_000);

  afterAll(() => h.close());

  const sweep = () =>
    h.moduleRef.get(SweepRunner).run(INSPECTION_SWEEP, new Date());
  const checklist = async (body: Record<string, unknown> = {}) =>
    a.checklist(
      s,
      [
        {
          kind: 'check',
          labelAr: 'سور',
          labelEn: 'Fence intact',
          failCreatesTicket: true,
          followUpCategoryId: await a.categoryId(s.c, 'general'),
          followUpPriority: 'urgent',
        },
        { kind: 'check', labelAr: 'إنارة', labelEn: 'Lights on' },
      ],
      { purpose: 'inspection', ...body },
    );
  const schedule = async (cl: string, target: object) =>
    (
      await a
        .http('post', '/maintenance/inspections', s.manager.token, {
          checklistId: cl,
          assigneeId: inspector.id,
          dueOn: day(1),
          ...target,
        })
        .expect(201)
    ).body as View;
  const mine = (
    id: string,
    path = '',
    body: object = {},
    method: 'post' | 'put' | 'get' = 'post',
  ) =>
    a.http(
      method,
      `/technician/inspections/${id}${path}`,
      inspector.token,
      body,
    );

  it('started, answered and submitted once; a failing item opens one follow-up for the area, offered to dispatch', async () => {
    const area = await a.area(s);
    const cl = await checklist();
    const i = await schedule(cl.id, { commonAreaId: area.id });
    const [fence, lights] = cl.items;
    await mine(i.id, `/items/${fence.id}`, { result: 'fail' }, 'put')
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('INSPECTION_NOT_STARTED'));
    await mine(i.id, '/start').expect(201);
    await mine(
      i.id,
      `/items/${fence.id}`,
      { result: 'fail', note: 'Two panels down' },
      'put',
    ).expect(200);
    await mine(i.id, `/items/${lights.id}`, { result: 'pass' }, 'put').expect(
      200,
    );
    const done = (await mine(i.id, '/submit').expect(201)).body as View;
    expect(done.status).toBe('submitted');
    expect(done.checklist).toMatchObject({
      status: 'submitted',
      attestationSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(done.findings).toEqual([
      {
        itemId: fence.id,
        ticketId: expect.any(String) as string,
        ticketStatus: 'new',
      },
    ]);
    const ticket = await a.inTenant(s.c, (tx) =>
      tx.ticket.findUniqueOrThrow({ where: { id: done.findings[0].ticketId } }),
    );
    expect(ticket).toMatchObject({
      origin: 'inspection',
      commonAreaId: area.id,
      priority: 'urgent',
      reporterId: inspector.id,
      description: 'Fence intact: Two panels down',
      categoryId: await a.categoryId(s.c, 'general'),
    });
    await mine(i.id, '/submit')
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('INSPECTION_ENDED'));
    // Only the inspector's: another's is not found; the manager reads all.
    await a
      .http('get', `/technician/inspections/${i.id}`, s.supervisor.token)
      .expect(403);
    await a
      .http('get', `/maintenance/inspections/${i.id}`, s.manager.token)
      .expect(200);
  });

  it('a checklist that asks for a scan: the place’s current tag only', async () => {
    const assetId = await a.asset(s);
    const cl = await checklist({ requireScan: true });
    const i = await schedule(cl.id, { assetId });
    const first = (
      await a
        .http('post', `/maintenance/assets/${assetId}/tag`, s.manager.token)
        .expect(201)
    ).body as {
      code: string;
    };
    const current = (
      await a
        .http('post', `/maintenance/assets/${assetId}/tag`, s.manager.token)
        .expect(201)
    ).body as {
      code: string;
    };
    const otherArea = await a.area(s);
    const other = (
      await a
        .http('post', `/maintenance/areas/${otherArea.id}/tag`, s.manager.token)
        .expect(201)
    ).body as {
      code: string;
    };
    await mine(i.id, '/start').expect(201);
    for (const item of cl.items)
      await mine(i.id, `/items/${item.id}`, { result: 'pass' }, 'put').expect(
        200,
      );
    await mine(i.id, '/submit')
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('INSPECTION_SCAN_REQUIRED'));
    for (const code of [first.code, other.code, 'JWA1.nonsense'])
      await mine(i.id, '/start', { code })
        .expect(409)
        .expect((r) => expect(err(r).code).toBe('INSPECTION_TAG_MISMATCH'));
    const scanned = (
      await mine(i.id, '/start', { code: current.code }).expect(201)
    ).body as View;
    expect(scanned.scannedAt).not.toBeNull();
    const done = (await mine(i.id, '/submit').expect(201)).body as View;
    expect(done.findings).toEqual([]);
  });

  it('a round opens one inspection per due date, however many sweeps; the inspector is told', async () => {
    const area = await a.area(s);
    const cl = await checklist();
    const round = (
      await a
        .http('post', '/maintenance/inspection-rounds', s.manager.token, {
          title: 'Weekly fence walk',
          checklistId: cl.id,
          commonAreaId: area.id,
          assigneeId: inspector.id,
          every: 1,
          unit: 'week',
          anchorOn: day(1),
          leadDays: 2,
        })
        .expect(201)
    ).body as { id: string; nextDueOn: string };
    expect(round.nextDueOn).toBe(day(1));
    await Promise.all([sweep(), sweep()]);
    await sweep();
    const opened = await a.inTenant(s.c, (tx) =>
      tx.inspection.findMany({ where: { roundId: round.id } }),
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      dueOn: dbDate(day(1)),
      status: 'scheduled',
      assigneeId: inspector.id,
    });
    const told = await a.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'inspection.assigned', targetId: opened[0].id },
      }),
    );
    expect(told.map((n) => n.accountId)).toEqual([inspector.id]);
    expect(told[0].params).toEqual({ targetRef: area.code, dueOn: day(1) });
    const next = (
      await a
        .http(
          'get',
          `/maintenance/inspection-rounds/${round.id}`,
          s.manager.token,
        )
        .expect(200)
    ).body as { nextDueOn: string };
    expect(next.nextDueOn).toBe(day(8));
  });

  it('past its day: the inspector and who manages them hear once; cancelled with a reason, it ends', async () => {
    const area = await a.area(s);
    const cl = await checklist();
    const i = await schedule(cl.id, { commonAreaId: area.id });
    await a.inTenant(
      s.c,
      (tx) =>
        tx.$executeRaw`UPDATE inspections SET due_on = ${dbDate(day(-2))}::date WHERE id = ${i.id}::uuid`,
    );
    await sweep();
    await sweep();
    const told = await a.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'inspection.overdue', targetId: i.id },
      }),
    );
    expect(told.map((n) => n.accountId).sort()).toEqual(
      [inspector.id, s.manager.id, s.supervisor.id].sort(),
    );
    await a
      .http(
        'post',
        `/maintenance/inspections/${i.id}/cancel`,
        s.manager.token,
        { reasonCode: 'target_unavailable' },
      )
      .expect(201)
      .expect((r) =>
        expect((r.body as { status: string }).status).toBe('cancelled'),
      );
    await mine(i.id, '/start')
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('INSPECTION_ENDED'));
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE inspections SET status = 'scheduled' WHERE id = ${i.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('refused with codes: an asset in a unit, an inspector who cannot inspect, a pm-only checklist', async () => {
    const cl = await checklist();
    await a
      .http('post', '/maintenance/inspections', s.manager.token, {
        checklistId: cl.id,
        assigneeId: inspector.id,
        dueOn: day(1),
        assetId: await a.asset(s, { unitId: s.unit.id }),
      })
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('INSPECTION_FOR_UNIT_ASSET'));
    await a
      .http('post', '/maintenance/inspections', s.manager.token, {
        checklistId: cl.id,
        assigneeId: s.owner.id,
        dueOn: day(1),
        commonAreaId: (await a.area(s)).id,
      })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'assigneeId', code: 'INSPECTOR_NOT_ELIGIBLE' },
        ]),
      );
    const pm = await a.checklist(s, undefined, { purpose: 'pm' });
    await a
      .http('post', '/maintenance/inspections', s.manager.token, {
        checklistId: pm.id,
        assigneeId: inspector.id,
        dueOn: day(1),
        commonAreaId: (await a.area(s)).id,
      })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'checklistId', code: 'CHECKLIST_NOT_AVAILABLE' },
        ]),
      );
  });

  it('the report counts what was done and followed up; its CSV is the same rows, through toCsv', async () => {
    const area = await a.area(s);
    const cl = await checklist();
    const i = await schedule(cl.id, { commonAreaId: area.id });
    await mine(i.id, '/start').expect(201);
    await mine(
      i.id,
      `/items/${cl.items[0].id}`,
      { result: 'fail' },
      'put',
    ).expect(200);
    await mine(
      i.id,
      `/items/${cl.items[1].id}`,
      { result: 'pass' },
      'put',
    ).expect(200);
    await mine(i.id, '/submit').expect(201);
    const report = (
      await a
        .http(
          'get',
          `/maintenance/inspection-report?from=${day(-1)}&to=${day(2)}`,
          s.manager.token,
        )
        .expect(200)
    ).body as {
      totals: Record<string, number | null>;
      rows: { inspectionId: string; onTime: boolean }[];
    };
    const row = report.rows.find((r) => r.inspectionId === i.id)!;
    expect(row).toMatchObject({
      status: 'submitted',
      failedItems: 1,
      findings: 1,
      findingsClosed: 0,
      onTime: true,
    });
    expect(report.totals.findings).toBeGreaterThanOrEqual(1);
    const csv = await a
      .http(
        'get',
        `/maintenance/inspection-report/export?from=${day(-1)}&to=${day(2)}`,
        s.manager.token,
      )
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['cache-control']).toBe('no-store');
    // toCsv's own: a byte-order mark, CRLF line ends, the header first
    // (its spec proves the formula guard on every text cell).
    expect(
      csv.text.startsWith('\uFEFFdue_on,status,target_kind,target_code,'),
    ).toBe(true);
    expect(csv.text).toContain('\r\n');
    const sheet = parseCsv(Buffer.from(csv.text, 'utf8'));
    const code = sheet.header.indexOf('target_code');
    expect(sheet.rows.map((r) => r.cells[code])).toContain(area.code);
    await a
      .http(
        'get',
        `/maintenance/inspection-report?from=${day(0)}&to=${day(400)}`,
        s.manager.token,
      )
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'to', code: 'INVALID_VALUE', params: { maxDays: 366 } },
        ]),
      );
  });
});
