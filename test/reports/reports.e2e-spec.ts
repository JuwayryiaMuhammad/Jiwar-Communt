import { strFromU8, unzipSync } from 'fflate';
import type { Response } from 'supertest';
import { err } from '../api/request';
import { day, today } from '../setup/compound-clock';
import { energyHelpers } from '../setup/energy';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface ReportBody {
  key: string;
  groupBy: string;
  compare: string;
  period: { from: string; to: string; days: number };
  previousPeriod: { from: string; to: string; days: number } | null;
  lastYearPeriod: { from: string; to: string; days: number } | null;
  columns: { key: string; kind: string; sum: boolean }[];
  rows: {
    values: (string | null)[];
    previous: (string | null)[] | null;
    lastYear: (string | null)[] | null;
  }[];
  totals: { values: (string | null)[] };
}

const binary = (res: Response, done: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

/**
 * ADR 0086: the curated reports — the catalog by permission, each report
 * aggregated by its groupings, compared with the period before and a year
 * earlier, and drawn as a PDF, a workbook and CSV (audited). Energy cost
 * per m² says why not instead of a number.
 */
describe('Reports — the curated reports', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let e: ReturnType<typeof energyHelpers>;
  let s: OperationsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    e = energyHelpers(h);
    s = await o.setUp(1);
  }, 120_000);

  afterAll(() => h.close());

  const get = (path: string, token = s.manager.token) =>
    o.http('get', path, token);
  const report = async (key: string, query: string, token = s.manager.token) =>
    (await get(`/staff/reports/view?report=${key}&${query}`, token).expect(200))
      .body as ReportBody;
  const row = (r: ReportBody, label: string | null) =>
    r.rows.find((x) => x.values[0] === label);

  it('the catalog lists the reports the caller may read; a report of another permission is refused', async () => {
    const all = (await get('/staff/reports').expect(200)).body as {
      data: { key: string; groupBy: string[] }[];
    };
    expect(all.data.map((r) => r.key)).toEqual([
      'maintenance_spend',
      'stock_consumption',
      'service_by_building',
      'energy_cost',
      'collections_by_building',
      'cash_flow',
    ]);
    expect(all.data[0].groupBy[0]).toBe('building');
    const mine = (await get('/staff/reports', s.supervisor.token).expect(200))
      .body as { data: { key: string }[] };
    expect(mine.data.map((r) => r.key)).toContain('service_by_building');
    expect(mine.data.map((r) => r.key)).not.toContain(
      'collections_by_building',
    );
    expect(
      err(
        await get(
          '/staff/reports/view?report=collections_by_building',
          s.supervisor.token,
        ).expect(403),
      ).code,
    ).toBe('REPORT_NOT_YOURS');
    expect(
      err(await get('/staff/reports/view?report=nothing').expect(400))
        .fields?.[0],
    ).toMatchObject({ field: 'report', code: 'INVALID_VALUE' });
    await get('/staff/reports', s.owner.token).expect(403);
  });

  it('maintenance spend by building: the costs of the period, split, with its share, and the totals', async () => {
    const ticket = await o.assignedTicket(s);
    for (const body of [
      {
        kind: 'labour',
        description: 'Two hours',
        quantity: '2',
        unitAmount: '100',
      },
      {
        kind: 'contractor',
        description: 'A visit',
        quantity: '1',
        unitAmount: '50',
      },
    ])
      await o
        .http(
          'post',
          `/maintenance/tickets/${ticket}/costs`,
          s.supervisor.token,
          body,
        )
        .expect(201);
    const r = await report(
      'maintenance_spend',
      `from=${today()}&to=${today()}&compare=both`,
    );
    expect(r.columns.map((c) => c.key)).toEqual([
      'building',
      'tickets',
      'labour',
      'contractor',
      'parts',
      'other',
      'total',
      'share',
    ]);
    const mine = row(r, s.building)!;
    expect(mine.values).toEqual([
      s.building,
      '1',
      '200.00',
      '50.00',
      '0',
      '0',
      '250.00',
      '100.0',
    ]);
    // Compared: the day before and the same day a year earlier had none.
    expect(r.previousPeriod).toEqual({
      from: day(-1),
      to: day(-1),
      days: 1,
    });
    expect(mine.previous).toEqual([
      s.building,
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      null,
    ]);
    expect(mine.lastYear).toEqual(mine.previous);
    expect(r.totals.values).toEqual([
      'Total',
      '1',
      '200.00',
      '50.00',
      '0.00',
      '0.00',
      '250.00',
      null,
    ]);
    const byCategory = await report(
      'maintenance_spend',
      `from=${today()}&to=${today()}&groupBy=category`,
    );
    expect(byCategory.rows.map((x) => x.values[0])).toContain('general');
    expect(byCategory.rows[0].previous).toBeNull();
  });

  it('a grouping the report does not offer, or a period past 366 days, is refused', async () => {
    const bad = err(
      await get(
        '/staff/reports/view?report=maintenance_spend&groupBy=unit',
      ).expect(400),
    );
    expect(bad.fields).toEqual([
      {
        field: 'groupBy',
        code: 'INVALID_VALUE',
        params: { allowed: ['building', 'asset_type', 'category', 'month'] },
      },
    ]);
    expect(
      err(
        await get(
          `/staff/reports/view?report=maintenance_spend&from=${day(-400)}&to=${today()}`,
        ).expect(400),
      ).fields?.[0],
    ).toMatchObject({ field: 'from', code: 'PERIOD_TOO_LONG' });
  });

  it('service by building: the work opened against the building’s share of the units', async () => {
    const r = await report(
      'service_by_building',
      `from=${today()}&to=${today()}`,
    );
    const mine = row(r, s.building)!;
    // One unit, at least the ticket opened above.
    expect(mine.values[1]).toBe('1');
    expect(Number(mine.values[2])).toBeGreaterThanOrEqual(1);
    expect(mine.values[8]).not.toBeNull();
  });

  it('a sensitive ticket counts only for a reader holding tickets.sensitive (ADR 0081)', async () => {
    const q = `from=${today()}&to=${today()}`;
    const opened = async (token: string) => {
      const r = await report('service_by_building', q, token);
      return Number(
        row(r, s.building)!.values[
          r.columns.findIndex((c) => c.key === 'opened')
        ],
      );
    };
    const ticket = await o.assignedTicket(s);
    const seen = {
      manager: await opened(s.manager.token),
      supervisor: await opened(s.supervisor.token),
    };
    expect(seen.manager).toBe(seen.supervisor);
    await o
      .http(
        'put',
        `/maintenance/tickets/${ticket}/sensitivity`,
        s.manager.token,
        { sensitive: true, reasonCode: 'resident_privacy' },
      )
      .expect(204);
    expect(await opened(s.manager.token)).toBe(seen.manager);
    expect(await opened(s.supervisor.token)).toBe(seen.supervisor - 1);
  });

  it('stock consumption by item: issued net of returns, its value at the average cost', async () => {
    const store = await o.store(s);
    const item = await o.item(s);
    await o.receive(s, item, store, '5', '10');
    const ticket = await o.startedTicket(s);
    const asked = (
      await o
        .http(
          'post',
          `/technician/tickets/${ticket}/part-requests`,
          s.techs[0].token,
          {
            itemId: item,
            quantity: '2',
          },
        )
        .expect(201)
    ).body as { id: string };
    await o
      .http(
        'post',
        `/maintenance/part-requests/${asked.id}/reserve`,
        s.manager.token,
        {
          storeId: store,
        },
      )
      .expect(200);
    await o
      .http(
        'post',
        `/maintenance/part-requests/${asked.id}/issue`,
        s.manager.token,
        {},
      )
      .expect(200);
    const r = await report(
      'stock_consumption',
      `from=${today()}&to=${today()}`,
    );
    const valve = r.rows.find((x) => x.values[1] === 'Valve')!;
    expect(valve.values.slice(3, 7)).toEqual(['2.000', '0', '2.000', '20.00']);
    const byType = await report(
      'stock_consumption',
      `from=${today()}&to=${today()}&groupBy=month`,
    );
    expect(byType.columns.map((c) => c.key)).toEqual([
      'month',
      'issues',
      'returns',
      'value',
    ]);
  });

  it('energy cost per m²: why not without a tariff or an area, the number with both', async () => {
    const meter = await e.meter(s, { unitId: s.unit.id, kind: 'electricity' });
    for (const [readOn, value] of [
      [day(-10), '100'],
      [day(-1), '190'],
    ])
      await e
        .http(
          'post',
          `/maintenance/meters/${meter.id}/readings`,
          s.manager.token,
          {
            readOn,
            value,
          },
        )
        .expect(201);
    const period = `from=${day(-9)}&to=${day(-1)}`;
    const mine = (r: ReportBody) =>
      r.rows.find(
        (x) => x.values[0] === s.building && x.values[1] === 'electricity',
      )!;
    expect(mine(await report('energy_cost', period)).values.slice(7)).toEqual([
      null,
      'no_tariff',
    ]);
    await e
      .http('post', '/maintenance/energy/tariffs', s.manager.token, {
        kind: 'electricity',
        effectiveOn: day(-30),
        pricePerUnit: '2',
      })
      .expect(201);
    expect(mine(await report('energy_cost', period)).values.slice(7)).toEqual([
      null,
      'no_area',
    ]);
    await o.inTenant(s.c, (tx) =>
      tx.unit.update({ where: { id: s.unit.id }, data: { areaSqm: '90' } }),
    );
    const known = mine(await report('energy_cost', period)).values;
    // 90 kWh over the nine days at 2 EGP, over 90 m².
    expect(known.slice(2, 9)).toEqual([
      known[2],
      'kWh',
      '180.00',
      '90.00',
      '0',
      '2.00',
      null,
    ]);
  });

  it('collections by building never show one household’s dues: a small building folds into the rest', async () => {
    const r = await report(
      'collections_by_building',
      `from=${day(-30)}&to=${day(30)}`,
    );
    expect(r.rows.every((x) => x.values[0] !== s.building)).toBe(true);
  });

  it('drawn as a PDF, a workbook and CSV, no-store, each audited by its key and format', async () => {
    const q = `from=${today()}&to=${today()}&compare=previous`;
    const pdf = await get(
      `/staff/reports/export?report=maintenance_spend&${q}&format=pdf`,
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['cache-control']).toContain('no-store');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const book = await get(
      `/staff/reports/export?report=maintenance_spend&${q}&format=xlsx`,
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    const sheet = strFromU8(
      unzipSync(new Uint8Array(book.body as Buffer))[
        'xl/worksheets/sheet1.xml'
      ],
    );
    expect(sheet).toContain('Total (period before)');
    expect(sheet).toContain(s.building);
    const csv = await get(
      `/staff/reports/export?report=maintenance_spend&${q}&format=csv`,
    )
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((csv.body as Buffer).toString('utf8').split('\r\n')[0]).toContain(
      'Building,Tickets,Tickets (period before),Tickets change %',
    );
    const entries = await o.inTenant(s.c, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'report.exported', actorId: s.manager.id },
      }),
    );
    expect(
      entries.map((a) => (a.metadata as { format: string }).format).sort(),
    ).toEqual(['csv', 'pdf', 'xlsx']);
    expect(JSON.stringify(entries)).not.toContain('250.00');
    expect(
      err(
        await get(
          `/staff/reports/export?report=maintenance_spend&${q}&format=doc`,
        ).expect(400),
      ).fields?.[0],
    ).toMatchObject({ field: 'format', code: 'INVALID_VALUE' });
  });
});
