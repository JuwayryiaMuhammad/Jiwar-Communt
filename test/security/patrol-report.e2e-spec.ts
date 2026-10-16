import { newId } from '../../src/core/common/uuid';
import { at, dbClock, today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type RouteBody, type Who } from '../setup/patrols';

const MINUTE = 60_000;

interface Counts {
  scheduled: number;
  done: number;
  late: number;
  missed: number;
  incomplete: number;
}

/**
 * ADR 0052: the patrol report per route over a period, and the patrol
 * counts the daily report (ADR 0050) gains per post, gates and zones
 * alike, in JSON and in the CSV's last five columns.
 */
describe('Patrol report and the daily report’s patrols', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let guard: Who;
  let shiftId: string;
  let gateId: string;
  let zoneId: string;
  let atGate: RouteBody;
  let inZone: RouteBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Patrol Report Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
    zoneId = (await x.places(s.manager)).clubhouse.id;
    const one = await x.checkpoint(supervisor, { gateId });
    const two = await x.checkpoint(supervisor, { gateId });
    atGate = await x.route(supervisor, { gateId }, [one.id, two.id]);
    const there = await x.checkpoint(supervisor, { zoneId });
    inZone = await x.route(supervisor, { zoneId }, [there.id]);
    guard = await x.guard(s.c);
    shiftId = (await x.start(guard, { gateId })).id;
    // At the gate, planned today: a run done late in 20 minutes, one
    // missed (and late), one timed out, one cancelled, one of the guard's
    // own ended short. In the zone: one missed. All of it on the
    // compound's today, by its clock: no earlier than 01:30, so the run
    // started 70 minutes before is today's too.
    const now = new Date(
      Math.max(dbClock().getTime(), at(today(), 1, 30).getTime()),
    );
    const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE);
    let n = 0;
    const run = (
      r: RouteBody,
      state: Record<string, unknown>,
      scheduled = true,
    ) => {
      const plannedAt = new Date(now.getTime() - MINUTE - ++n * 1000);
      return x.inTx(s.c, (tx) =>
        tx.patrolRun.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            routeId: r.id,
            versionId: r.version.id,
            gateId: r.post.gateId,
            placeId: r.post.zone?.id ?? null,
            kind: scheduled ? 'scheduled' : 'adhoc',
            plannedAt,
            scheduledStart: scheduled ? plannedAt : null,
            windowEndsAt: scheduled
              ? new Date(plannedAt.getTime() + 30 * MINUTE)
              : null,
            checkpointsTotal: r.version.checkpoints,
            status: 'scheduled',
            ...state,
          },
        }),
      );
    };
    const started = (minutesAgo: number) => ({
      guardAccountId: guard.id,
      shiftId,
      startedAt: ago(minutesAgo),
      endedAt: now,
    });
    const done = await run(atGate, {
      ...started(20),
      status: 'completed',
      scannedCount: 2,
      lateAt: now,
    });
    await run(atGate, {
      status: 'missed',
      lateAt: now,
      endedAt: now,
    });
    await run(atGate, { ...started(70), status: 'timed_out' });
    await run(atGate, {
      status: 'cancelled',
      cancelReason: 'not_needed',
      cancelledById: supervisor.id,
      endedAt: now,
    });
    const own = {
      ...started(10),
      status: 'incomplete' as const,
      endReason: 'guard',
    };
    const short = await x.inTx(s.c, (tx) =>
      tx.patrolRun.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          routeId: atGate.id,
          versionId: atGate.version.id,
          gateId,
          kind: 'adhoc',
          plannedAt: own.startedAt,
          checkpointsTotal: 2,
          ...own,
        },
      }),
    );
    await run(inZone, { status: 'missed', endedAt: now });
    // Scans: by hand, flagged, and one received after its run ended.
    const scan = (
      runId: string,
      checkpointId: string,
      extra: Record<string, unknown>,
    ) =>
      x.inTx(s.c, (tx) =>
        tx.patrolScan.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            runId,
            checkpointId,
            position: 1,
            method: 'qr',
            scannedAt: ago(5),
            receivedAt: ago(5),
            guardAccountId: guard.id,
            ...extra,
          },
        }),
      );
    await scan(done.id, one.id, {
      method: 'manual',
      manualReason: 'qr_damaged',
    });
    await scan(done.id, two.id, {
      position: 2,
      lat: 30,
      lng: 31,
      distanceM: 900,
      positionSuspect: true,
    });
    await scan(short.id, one.id, { receivedAt: ago(-1) });
  }, 180_000);

  afterAll(() => h.close());

  it('the patrol report: per route, the runs planned in the period and their scans', async () => {
    const report = (
      await x
        .http('get', '/staff/security/patrols/report', supervisor.token)
        .expect(200)
    ).body as {
      from: string;
      to: string;
      routes: (Counts & {
        route: { id: string };
        adhoc: number;
        cancelled: number;
        manualScans: number;
        suspectScans: number;
        lateScans: number;
        avgMinutes: number | null;
      })[];
    };
    expect(report.to).toBe(today());
    const gate = report.routes.find((r) => r.route.id === atGate.id);
    expect(gate).toMatchObject({
      scheduled: 3,
      adhoc: 1,
      done: 1,
      late: 2,
      missed: 1,
      incomplete: 2,
      cancelled: 1,
      manualScans: 1,
      suspectScans: 1,
      lateScans: 1,
      avgMinutes: 20,
    });
    const zone = report.routes.find((r) => r.route.id === inZone.id);
    expect(zone).toMatchObject({ scheduled: 1, missed: 1, avgMinutes: null });
    const one = (
      await x
        .http(
          'get',
          `/staff/security/patrols/report?routeId=${inZone.id}`,
          supervisor.token,
        )
        .expect(200)
    ).body as { routes: { route: { id: string } }[] };
    expect(one.routes.map((r) => r.route.id)).toEqual([inZone.id]);
  });

  it('the daily report counts each post’s patrols, a zone’s too; the CSV carries them last', async () => {
    const date = today();
    const daily = (
      await x
        .http(
          'get',
          `/staff/security/reports/daily?date=${date}`,
          supervisor.token,
        )
        .expect(200)
    ).body as {
      posts: {
        post: { gateId: string | null; zone: { id: string } | null };
        patrols: Counts;
      }[];
    };
    const gate = daily.posts.find((p) => p.post.gateId === gateId)!;
    expect(gate.patrols).toEqual({
      scheduled: 3,
      done: 1,
      late: 2,
      missed: 1,
      incomplete: 2,
    });
    const zone = daily.posts.find((p) => p.post.zone?.id === zoneId)!;
    expect(zone.patrols).toEqual({
      scheduled: 1,
      done: 0,
      late: 0,
      missed: 1,
      incomplete: 0,
    });
    const csv = (
      await x
        .http(
          'get',
          `/staff/security/reports/daily/export?date=${date}&gateId=${gateId}`,
          supervisor.token,
        )
        .buffer(true)
        .parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200)
    ).body as Buffer;
    const [head, row] = csv.toString('utf8').slice(1).trimEnd().split('\r\n');
    const cells = Object.fromEntries(
      head.split(',').map((k, i) => [k, row.split(',')[i]]),
    );
    expect(head.split(',').slice(-5)).toEqual([
      'patrols_scheduled',
      'patrols_done',
      'patrols_late',
      'patrols_missed',
      'patrols_incomplete',
    ]);
    expect(cells).toMatchObject({
      patrols_scheduled: '3',
      patrols_done: '1',
      patrols_late: '2',
      patrols_missed: '1',
      patrols_incomplete: '2',
    });
  });

  it('read with patrols.manage or guard_reports.read; never by a guard', async () => {
    const reader = await x.staff(s.c, ['guard_reports.read']);
    await x
      .http('get', '/staff/security/patrols/report', reader.token)
      .expect(200);
    const keeper = await x.staff(s.c, ['patrols.manage']);
    await x
      .http('get', '/staff/security/patrols/report', keeper.token)
      .expect(200);
    expect(
      (await x.http('get', '/staff/security/patrols/report', guard.token))
        .status,
    ).toBe(403);
  });
});
