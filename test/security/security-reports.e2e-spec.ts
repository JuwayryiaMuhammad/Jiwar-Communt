import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

type Counts = Record<string, number | string | null>;
interface IncidentReport {
  from: string;
  to: string;
  totals: Counts;
  types: (Counts & { type: string })[];
}
interface ViolationReport {
  from: string;
  to: string;
  currency: string;
  totals: Counts;
  kinds: (Counts & { kind: string })[];
}

/**
 * ADR 0053: the incidents report and the violations report, over the
 * compound's days (a week by default, 31 at most), JSON and CSV: counts
 * per type or kind, every one listed, the totals; never a name, a unit or
 * a word anyone wrote. Read with `incidents.manage` / `violations.manage`
 * or `guard_reports.read`.
 */
describe('Security reports — incidents and violations', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };
  let supervisor: Who;
  let placeId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Security Reports Court');
    guard = await x.guardOnDuty(s.c);
    supervisor = await x.supervisor(s.c);
    placeId = (await x.places(s.alice)).clubhouse.id;
  }, 120_000);

  afterAll(() => h.close());

  const post = async (
    as: Who,
    path: string,
    body: Record<string, unknown>,
    status = 201,
  ) => {
    const res = await x.http('post', path, as.token, body);
    if (res.status !== status)
      throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; payments?: { id: string }[] };
  };
  const incident = (as: Who, path: string, body: Record<string, unknown>) =>
    post(as, path, {
      placeId,
      occurredAt: new Date(Date.now() - 600_000).toISOString(),
      description: 'Words nobody else reads in a report',
      ...body,
    });
  const violation = (as: Who, path: string, body: Record<string, unknown>) =>
    post(as, path, { unitCode: s.home.code, occurredOn: day(0), ...body });
  const csv = async (path: string, as: Who = s.manager) => {
    const res = await x
      .http('get', path, as.token)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['cache-control']).toBe('no-store');
    const text = (res.body as Buffer).toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);
    const [head, ...rows] = text.slice(1).trimEnd().split('\r\n');
    const keys = head.split(',');
    return {
      disposition: res.headers['content-disposition'],
      rows: rows.map((r) =>
        Object.fromEntries(r.split(',').map((v, i) => [keys[i], v])),
      ),
      keys,
    };
  };

  it('incidents: per type by severity and state, the guards’ share, hours to a close; the CSV the same, the totals last', async () => {
    await incident(guard, '/gate/incidents', {
      type: 'hazard',
      severity: 'low',
    });
    await incident(guard, '/gate/incidents', {
      type: 'injury',
      severity: 'critical',
    });
    const office = await incident(s.manager, '/staff/security/incidents', {
      type: 'hazard',
      severity: 'high',
    });
    await post(
      s.manager,
      `/staff/security/incidents/${office.id}/close`,
      { reasonCode: 'resolved', note: 'Closed for the report' },
      200,
    );
    const res = await x
      .http('get', '/staff/security/reports/incidents', supervisor.token)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const r = res.body as IncidentReport;
    expect(r).toMatchObject({ from: day(-6), to: day(0) });
    expect(r.totals).toEqual({
      reported: 3,
      byGuards: 2,
      low: 1,
      medium: 0,
      high: 1,
      critical: 1,
      open: 2,
      investigating: 0,
      closed: 1,
      avgHoursToClose: expect.any(Number) as number,
    });
    const hazard = r.types.find((t) => t.type === 'hazard');
    expect(hazard).toMatchObject({
      reported: 2,
      byGuards: 1,
      low: 1,
      high: 1,
      open: 1,
      closed: 1,
    });
    expect(r.types.find((t) => t.type === 'fire')).toMatchObject({
      reported: 0,
      avgHoursToClose: null,
    });
    const text = JSON.stringify(r);
    for (const secret of [guard.id, s.manager.id, s.home.code, 'Words'])
      expect(text).not.toContain(secret);

    const file = await csv('/staff/security/reports/incidents/export');
    expect(file.disposition).toBe(
      `attachment; filename="security-incidents-${day(-6)}-${day(0)}.csv"`,
    );
    expect(file.keys).toEqual([
      'type',
      'reported',
      'by_guards',
      'low',
      'medium',
      'high',
      'critical',
      'open',
      'investigating',
      'closed',
      'avg_hours_to_close',
    ]);
    expect(file.rows.map((row) => row.type)).toEqual([
      ...r.types.map((t) => t.type),
      'all',
    ]);
    expect(file.rows.at(-1)).toMatchObject({
      reported: '3',
      by_guards: '2',
      closed: '1',
    });
    expect(file.rows.find((row) => row.type === 'fire')).toMatchObject({
      reported: '0',
      avg_hours_to_close: '',
    });

    // Another period: nothing happened then.
    const before = (
      await x
        .http(
          'get',
          `/staff/security/reports/incidents?from=${day(-20)}&to=${day(-14)}`,
          s.manager.token,
        )
        .expect(200)
    ).body as IncidentReport;
    expect(before.totals).toMatchObject({ reported: 0, avgHoursToClose: null });
  });

  it('violations: per kind, warnings and fines, the amounts issued and paid, the appeals and their decisions', async () => {
    await violation(guard, '/gate/violations', { kind: 'noise' });
    const paid = await violation(s.manager, '/staff/violations', {
      kind: 'waste',
      amount: '250',
    });
    const accountant = await x.staff(s.c, ['fines.billing']);
    await post(accountant, `/staff/violations/${paid.id}/payments`, {
      amount: '250',
      receiptNumber: `SR-${Date.now() % 100000}`,
      paidOn: day(0),
    });
    const accepted = await violation(s.manager, '/staff/violations', {
      kind: 'waste',
      amount: '100',
    });
    const upheld = await violation(s.manager, '/staff/violations', {
      kind: 'pets',
      amount: '80',
    });
    for (const [v, decision] of [
      [accepted, 'cancelled'],
      [upheld, 'upheld'],
    ] as const) {
      await post(
        s.alice,
        `/violations/${v.id}/appeal`,
        { reason: 'Not us' },
        200,
      );
      await post(
        s.manager,
        `/staff/violations/${v.id}/decide-appeal`,
        { decision },
        200,
      );
    }
    const r = (
      await x
        .http('get', '/staff/security/reports/violations', supervisor.token)
        .expect(200)
    ).body as ViolationReport;
    expect(r).toMatchObject({ from: day(-6), to: day(0), currency: 'EGP' });
    expect(r.totals).toEqual({
      issued: 4,
      byGuards: 1,
      warnings: 1,
      fined: 3,
      amountIssued: '430.00',
      open: 2,
      underAppeal: 0,
      paid: 1,
      cancelled: 1,
      amountPaid: '250.00',
      appealed: 2,
      appealsUpheld: 1,
      appealsAccepted: 1,
    });
    expect(r.kinds.map((k) => k.kind)).toEqual([
      'noise',
      'waste',
      'pets',
      'contractor_hours',
      'other',
    ]);
    expect(r.kinds.find((k) => k.kind === 'waste')).toMatchObject({
      issued: 2,
      fined: 2,
      amountIssued: '350.00',
      paid: 1,
      cancelled: 1,
      amountPaid: '250.00',
      appealed: 1,
      appealsAccepted: 1,
    });
    expect(r.kinds.find((k) => k.kind === 'other')).toMatchObject({
      issued: 0,
      amountIssued: '0.00',
    });
    const text = JSON.stringify(r);
    for (const secret of [guard.id, s.alice.id, s.home.code, 'Not us'])
      expect(text).not.toContain(secret);

    const file = await csv('/staff/security/reports/violations/export');
    expect(file.disposition).toBe(
      `attachment; filename="security-violations-${day(-6)}-${day(0)}.csv"`,
    );
    expect(file.keys.at(0)).toBe('kind');
    expect(file.keys.at(-1)).toBe('currency');
    expect(file.rows.at(-1)).toMatchObject({
      kind: 'all',
      issued: '4',
      amount_issued: '430.00',
      amount_paid: '250.00',
      currency: 'EGP',
    });
  });

  it('the daily report counts, at the guard’s gate, what they reported and issued on shift; the office’s never', async () => {
    const daily = (
      await x
        .http(
          'get',
          `/staff/security/reports/daily?gateId=${guard.gateId}`,
          supervisor.token,
        )
        .expect(200)
    ).body as {
      posts: {
        post: { gateId: string | null };
        counts: { incidents: number; violations: number };
      }[];
    };
    expect(
      daily.posts.find((p) => p.post.gateId === guard.gateId)?.counts,
    ).toMatchObject({ incidents: 2, violations: 1 });
    const file = await csv(
      `/staff/security/reports/daily/export?gateId=${guard.gateId}`,
      supervisor,
    );
    expect(file.keys.slice(-2)).toEqual(['incidents', 'violations']);
    expect(file.rows[0]).toMatchObject({ incidents: '2', violations: '1' });
  });

  it('who reads: the keepers of each, or guard_reports.read; never a guard or the accountant; 31 days at most', async () => {
    const reader = await x.staff(s.c, ['guard_reports.read']);
    const incidentsOnly = await x.staff(s.c, ['incidents.manage']);
    const violationsOnly = await x.staff(s.c, ['violations.manage']);
    const accountant = await x.staff(s.c, ['fines.billing']);
    const status = async (who: Who, report: string) =>
      (await x.http('get', `/staff/security/reports/${report}`, who.token))
        .status;
    for (const report of ['incidents', 'violations']) {
      expect(await status(reader, report)).toBe(200);
      expect(await status(guard, report)).toBe(403);
      expect(await status(accountant, report)).toBe(403);
    }
    expect(await status(incidentsOnly, 'incidents')).toBe(200);
    expect(await status(incidentsOnly, 'violations')).toBe(403);
    expect(await status(violationsOnly, 'violations')).toBe(200);
    expect(await status(violationsOnly, 'incidents')).toBe(403);
    await x
      .http(
        'get',
        `/staff/security/reports/violations/export?from=${day(-40)}&to=${day(0)}`,
        s.manager.token,
      )
      .expect(400)
      .expect((res) =>
        expect(res.body).toMatchObject({
          fields: [
            { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 31 } },
          ],
        }),
      );
  });
});
