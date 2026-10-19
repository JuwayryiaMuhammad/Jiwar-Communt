import { day, today } from '../setup/compound-clock';
import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface TrafficCounts {
  visitors: {
    visitorPass: number;
    gateRequest: number;
    fieldException: number;
  };
  serviceVehicles: {
    tanker: number;
    waste: number;
    delivery: number;
    other: number;
  };
  residentVehicles: { in: number; out: number };
}
interface Traffic {
  from: string;
  to: string;
  rows: (TrafficCounts & {
    date: string;
    gate: { id: string; name: string };
  })[];
  totals: TrafficCounts;
}

/**
 * ADR 0056, the traffic report: per compound day and gate, visitors by how
 * they came in, service vehicles by kind, and resident vehicles counted in
 * and out (a count only: nothing logs whose). For the management; counts,
 * never a name, a unit or a plate; JSON and CSV; 31 days at most.
 */
describe('Gate — traffic, and resident vehicles counted (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;
  let vehicleId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Traffic Court');
    vehicleId = (await g.register(s.alice, s.home.id)).id;
  }, 180_000);

  afterAll(() => h.close());

  const count = (direction: 'in' | 'out', headers = {}) =>
    g.http(
      'post',
      '/gate/vehicle-passages',
      s.guard.token,
      { vehicleId, direction },
      headers,
    );
  const traffic = async (query = '') =>
    (
      await g
        .http(
          'get',
          `/staff/gate/reports/traffic?gateId=${s.guard.gateId}${query}`,
          s.manager.token,
        )
        .expect(200)
    ).body as Traffic;

  it('counts today’s visitors, service vehicles and resident vehicles at the gate', async () => {
    const pass = await g.pass(s.alice, s.home.id);
    await g.enter(s.guard, 'visitor_pass', pass.id);
    const x = await g.visitor(s.guard, s.unitCode);
    await g.approve(s.manager, x.id);
    await g.enter(s.guard, 'field_exception', x.id);
    await g.serviceIn(s.guard, 'ت ع 6601', { kind: 'waste' });
    await count('in').expect(201);
    await count('in').expect(201);
    await count('out').expect(201);
    const r = await traffic();
    const row = r.rows.find((x) => x.date === today())!;
    expect(row).toMatchObject({
      gate: { id: s.guard.gateId },
      visitors: { visitorPass: 1, gateRequest: 0, fieldException: 1 },
      serviceVehicles: { tanker: 0, waste: 1, delivery: 0, other: 0 },
      residentVehicles: { in: 2, out: 1 },
    });
    expect(r.totals.residentVehicles).toEqual({ in: 2, out: 1 });
    // A week by default: a row a day for the gate asked.
    expect(r.from).toBe(day(-6));
    expect(r.to).toBe(today());
    expect(r.rows).toHaveLength(7);
    // Counts only.
    expect(JSON.stringify(r)).not.toMatch(
      new RegExp(`${s.unitCode}|ت ع|Nile Water`),
    );
  });

  it('a resident vehicle is counted, never logged: no row, no audit, no record names it', async () => {
    const key = { 'Idempotency-Key': '0192e000-0000-7000-8000-00000000c001' };
    const first = await count('out', key).expect(201);
    const again = await count('out', key).expect(201);
    expect(first.body).toEqual({ counted: true });
    expect(again.body).toEqual({ counted: true });
    const rows = await g.inTx(s.c, async (tx) => ({
      counts: await tx.gateVehicleCount.findMany(),
      audit: await tx.auditLog.findMany({
        where: { targetId: vehicleId, action: { not: 'vehicle.registered' } },
      }),
      keys: await tx.idempotencyKey.findMany({
        where: {
          accountId: s.guard.id,
          route: { contains: 'vehicle-passages' },
        },
      }),
    }));
    // The retry counted once: out is 2 now (one before, one here).
    expect(rows.counts.find((c) => c.direction === 'out')?.count).toBe(2);
    expect(JSON.stringify(rows.counts)).not.toContain(vehicleId);
    expect(rows.audit).toEqual([]);
    expect(JSON.stringify(rows.keys)).not.toContain(vehicleId);
  });

  it('a vehicle that is not registered, or another compound’s, is not counted', async () => {
    const other = await g.setUp('Traffic Elsewhere');
    const theirs = (await g.register(other.alice, other.home.id)).id;
    for (const id of [theirs, '00000000-0000-7000-8000-000000000000'])
      expect(
        (
          (
            await g
              .http('post', '/gate/vehicle-passages', s.guard.token, {
                vehicleId: id,
                direction: 'in',
              })
              .expect(404)
          ).body as { code: string }
        ).code,
      ).toBe('VEHICLE_NOT_FOUND');
  });

  it('as CSV, the totals last; the management only; 31 days at most', async () => {
    const res = await g
      .http(
        'get',
        `/staff/gate/reports/traffic/export?gateId=${s.guard.gateId}&from=${today()}&to=${today()}`,
        s.manager.token,
      )
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="gate-traffic-${today()}-${today()}.csv"`,
    );
    const lines = (res.body as Buffer)
      .toString('utf8')
      .slice(1)
      .trimEnd()
      .split('\r\n');
    expect(lines[0]).toBe(
      'date,gate,visitors_pass,visitors_gate_request,visitors_field_exception,service_tanker,service_waste,service_delivery,service_other,resident_vehicles_in,resident_vehicles_out',
    );
    expect(lines).toHaveLength(3);
    expect(lines[2].startsWith('all,all,')).toBe(true);
    await g
      .http('get', '/staff/gate/reports/traffic', s.guard.token)
      .expect(403);
    const long = await g
      .http(
        'get',
        `/staff/gate/reports/traffic?from=${day(-40)}&to=${today()}`,
        s.manager.token,
      )
      .expect(400);
    expect((long.body as { fields: unknown[] }).fields).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 31 } },
    ]);
  });
});
