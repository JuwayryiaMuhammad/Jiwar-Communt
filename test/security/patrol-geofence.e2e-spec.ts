import { newId } from '../../src/core/common/uuid';
import { PATROL_GEOFENCE_SWEEP } from '../../src/gate/patrols/patrol-geofence';
import { PATROL_TRACK_PURGE_SWEEP } from '../../src/gate/patrols/patrol-track.service';
import { dbClock } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type RunBody, type Who } from '../setup/patrols';
import { incidentRow } from '../setup/security-ops-rows';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

// A circle of 100 m, and a square of about 222 m a side, around a compound.
const CENTRE = { lat: 30.0444, lng: 31.2357 };
const CIRCLE = { circle: { ...CENTRE, radiusM: 100 } };
const SQUARE: [number, number][] = [
  [30.0434, 31.2345],
  [30.0434, 31.2368],
  [30.0454, 31.2368],
  [30.0454, 31.2345],
];
const INSIDE = CENTRE;
// About 330 m north: outside both.
const OUTSIDE = { lat: 30.0474, lng: 31.2357 };

interface ExitBody {
  id: string;
  leftAt: string;
  backAt: string | null;
  flaggedAt: string | null;
  flaggedMinutes: number | null;
}

/**
 * ADR 0056, the patrol geofence: a route version may say where a patrol of
 * it stays. The run's points are walked in time order as they arrive; an
 * exit lasting the gate's `geofenceExitMinutes` (1 here) is flagged to the
 * `patrols.manage` holders once — by the batch that shows it, or by the
 * sweep while no point says more. Times only, never where. Points are
 * deleted after 30 days unless an incident keeps the run's track. Every
 * point's time is relative to the run's start, by the database's clock.
 */
describe('Patrol geofence (ADR 0056)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let manager: Who;
  let gateId: string;
  let checkpointId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Geofence Court');
    supervisor = await x.supervisor(s.c);
    manager = s.manager;
    gateId = (await x.g.gate(s.c)).id;
    checkpointId = (await x.checkpoint(supervisor, { gateId })).id;
    await x
      .http('patch', '/staff/gate/settings', manager.token, {
        geofenceExitMinutes: 1,
      })
      .expect(200);
  }, 180_000);

  afterAll(() => h.close());

  const fenced = (geofence: object | null) =>
    x.route(supervisor, { gateId }, [checkpointId], { geofence });

  /** A guard walking a run of the route; `t(ms)` a time from its start. */
  async function walking(routeId: string) {
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    const run: RunBody = await x.adhoc(guard, routeId);
    const start = new Date(run.startedAt!).getTime();
    const t = (ms: number) => new Date(start + ms).toISOString();
    return { guard, run, t };
  }
  const send = (as: Who, runId: string, points: object[]) =>
    x
      .http('post', `/gate/patrols/runs/${runId}/track`, as.token, { points })
      .expect(200);
  const point = (
    recordedAt: string,
    where: { lat: number; lng: number },
    accuracyM = 5,
  ) => ({ recordedAt, ...where, accuracyM });
  const exits = async (runId: string) =>
    (
      (
        await x
          .http(
            'get',
            `/staff/security/patrols/runs/${runId}/geofence-exits`,
            supervisor.token,
          )
          .expect(200)
      ).body as { data: ExitBody[] }
    ).data;
  const flags = async (accountId: string, runId: string) =>
    (await x.told(s.c, accountId, runId)).filter(
      (n) => n.kind === 'patrol.geofence_exit',
    );

  it('a circle: an exit that lasted the threshold is flagged once, to every patrols.manage holder; a short one is not', async () => {
    const route = await fenced(CIRCLE);
    expect(route.version).toMatchObject({ geofence: CIRCLE });
    const { guard, run, t } = await walking(route.id);
    const batch = [
      point(t(-60 * SECOND), INSIDE),
      point(t(-50 * SECOND), OUTSIDE),
      point(t(-30 * SECOND), OUTSIDE),
      point(t(20 * SECOND), INSIDE),
      // 20 seconds out: under the threshold.
      point(t(30 * SECOND), OUTSIDE),
      point(t(50 * SECOND), INSIDE),
    ];
    expect((await send(guard, run.id, batch)).body).toEqual({
      accepted: 6,
      rejected: 0,
    });
    // Sent again: nothing new, nobody told twice.
    await send(guard, run.id, batch);
    await x.sweep(PATROL_GEOFENCE_SWEEP);
    const [long, short] = await exits(run.id);
    expect(long).toMatchObject({
      leftAt: t(-50 * SECOND),
      backAt: t(20 * SECOND),
      flaggedMinutes: 1,
    });
    expect(long.flaggedAt).not.toBeNull();
    expect(short).toMatchObject({
      leftAt: t(30 * SECOND),
      backAt: t(50 * SECOND),
      flaggedAt: null,
    });
    expect(await exits(run.id)).toHaveLength(2);
    for (const keeper of [supervisor, manager])
      expect(await flags(keeper.id, run.id)).toEqual([
        { kind: 'patrol.geofence_exit', params: { minutes: 1 } },
      ]);
    expect(await flags(guard.id, run.id)).toEqual([]);
    await x.endRunRaw(guard, run.id).expect(200);
  });

  it('a polygon: the same, batch by batch; a point older than one walked is kept, not walked', async () => {
    const route = await fenced({ polygon: SQUARE });
    expect(route.version).toMatchObject({ geofence: { polygon: SQUARE } });
    const { guard, run, t } = await walking(route.id);
    await send(guard, run.id, [point(t(-70 * SECOND), OUTSIDE)]);
    expect(await exits(run.id)).toMatchObject([
      { leftAt: t(-70 * SECOND), backAt: null, flaggedAt: null },
    ]);
    await send(guard, run.id, [point(t(-5 * SECOND), OUTSIDE)]);
    const [open] = await exits(run.id);
    // 65 seconds outside by its latest point: flagged, still open.
    expect(open).toMatchObject({ backAt: null, flaggedMinutes: 1 });
    // Late from the queue: older than the last walked; kept in the track.
    await send(guard, run.id, [point(t(-40 * SECOND), INSIDE)]);
    await send(guard, run.id, [point(t(10 * SECOND), INSIDE)]);
    expect(await exits(run.id)).toMatchObject([
      { leftAt: t(-70 * SECOND), backAt: t(10 * SECOND), flaggedMinutes: 1 },
    ]);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.patrolTrackPoint.count({ where: { runId: run.id } }),
      ),
    ).toBe(4);
    expect(await flags(supervisor.id, run.id)).toHaveLength(1);
    await x.endRunRaw(guard, run.id).expect(200);
  });

  it('a point too imprecise says nothing; one outside within its accuracy is not out', async () => {
    const route = await fenced(CIRCLE);
    const { guard, run, t } = await walking(route.id);
    // About 22 m past the edge, with 50 m of accuracy; then 330 m out, at 150 m.
    const nearEdge = { lat: 30.0455, lng: 31.2357 };
    await send(guard, run.id, [
      point(t(-60 * SECOND), nearEdge, 50),
      point(t(-30 * SECOND), OUTSIDE, 150),
      point(t(10 * SECOND), INSIDE),
    ]);
    expect(await exits(run.id)).toEqual([]);
    await x.endRunRaw(guard, run.id).expect(200);
  });

  it('no geofence: nothing is watched', async () => {
    const route = await fenced(null);
    expect(route.version).toMatchObject({ geofence: null });
    const { guard, run, t } = await walking(route.id);
    await send(guard, run.id, [
      point(t(-60 * SECOND), OUTSIDE),
      point(t(10 * SECOND), OUTSIDE),
    ]);
    expect(await exits(run.id)).toEqual([]);
    await x.endRunRaw(guard, run.id).expect(200);
  });

  describe('the sweep', () => {
    it('flags an open exit past the threshold once, even with no more points; a later return keeps the one flag', async () => {
      const route = await fenced(CIRCLE);
      const { guard, run, t } = await walking(route.id);
      await send(guard, run.id, [point(t(-90 * SECOND), OUTSIDE)]);
      expect((await exits(run.id))[0].flaggedAt).toBeNull();
      await x.sweep(PATROL_GEOFENCE_SWEEP);
      await x.sweep(PATROL_GEOFENCE_SWEEP);
      expect((await exits(run.id))[0]).toMatchObject({
        backAt: null,
        flaggedMinutes: 1,
      });
      await send(guard, run.id, [point(t(10 * SECOND), INSIDE)]);
      expect((await exits(run.id))[0].backAt).toBe(t(10 * SECOND));
      expect(await flags(supervisor.id, run.id)).toHaveLength(1);
      await x.endRunRaw(guard, run.id).expect(200);
    });

    it('not before the threshold, and never past the run’s end', async () => {
      const route = await fenced(CIRCLE);
      const guard = await x.guard(s.c);
      await x.start(guard, { gateId });
      const now = dbClock().getTime();
      // Under way, out 20 seconds: not yet.
      const recent = await runWithExit(guard, route, {
        startedAt: now - 5 * MINUTE,
        endedAt: null,
        leftAt: now - 20 * SECOND,
      });
      // Ended ten minutes ago, 30 seconds after its guard went out.
      const ended = await runWithExit(guard, route, {
        startedAt: now - 40 * MINUTE,
        endedAt: now - 10 * MINUTE,
        leftAt: now - 10 * MINUTE - 30 * SECOND,
      });
      await x.sweep(PATROL_GEOFENCE_SWEEP);
      for (const runId of [recent, ended]) {
        expect((await exits(runId))[0].flaggedAt).toBeNull();
        expect(await flags(supervisor.id, runId)).toEqual([]);
      }
      await x.endRaw(guard).expect(200);
    });
  });

  /** A run row and an open exit of it, written as the walk would have. */
  async function runWithExit(
    guard: Who,
    route: { id: string; version: { id: string } },
    at: { startedAt: number; endedAt: number | null; leftAt: number },
  ): Promise<string> {
    const id = newId();
    await x.inTx(s.c, async (tx) => {
      await tx.patrolRun.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          routeId: route.id,
          versionId: route.version.id,
          gateId,
          kind: 'adhoc',
          plannedAt: new Date(at.startedAt),
          status: at.endedAt ? 'incomplete' : 'in_progress',
          endReason: at.endedAt ? 'guard' : null,
          guardAccountId: guard.id,
          shiftId: (
            await tx.guardShift.findFirstOrThrow({
              where: { guardAccountId: guard.id, endedAt: null },
            })
          ).id,
          startedAt: new Date(at.startedAt),
          endedAt: at.endedAt ? new Date(at.endedAt) : null,
          checkpointsTotal: 1,
        },
      });
      await tx.patrolGeofenceExit.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          runId: id,
          guardAccountId: guard.id,
          leftAt: new Date(at.leftAt),
        },
      });
    });
    return id;
  }

  describe('a route’s geofence is checked', () => {
    const create = (geofence: object) =>
      x.routeRaw(supervisor, {
        gateId,
        nameEn: `Fenced ${newId().slice(-6)}`,
        nameAr: `مسار ${newId().slice(-6)}`,
        version: {
          checkpointIds: [checkpointId],
          ordered: false,
          expectedMinutes: 30,
          geofence,
        },
      });

    it('one of a circle and a polygon', async () => {
      expect(fields(await create({}))).toEqual([
        { field: 'version.geofence.circle', code: 'FIELD_REQUIRED' },
      ]);
      expect(fields(await create({ ...CIRCLE, polygon: SQUARE }))).toEqual([
        { field: 'version.geofence.circle', code: 'FIELD_NOT_ALLOWED' },
      ]);
    });

    it('a polygon of 3 to 50 vertices whose edges never cross', async () => {
      expect(fields(await create({ polygon: SQUARE.slice(0, 2) }))).toEqual([
        {
          field: 'version.geofence.polygon',
          code: 'INVALID_LENGTH',
          params: { min: 3, max: 50 },
        },
      ]);
      const bowTie = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]];
      expect(fields(await create({ polygon: bowTie }))).toEqual([
        { field: 'version.geofence.polygon', code: 'INVALID_VALUE' },
      ]);
    });

    it('a circle of 10 to 5000 metres', async () => {
      const res = await create({ circle: { ...CENTRE, radiusM: 5 } });
      expect(code(res)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
      expect(JSON.stringify(fields(res))).toContain('radiusM');
    });
  });

  describe('retention', () => {
    it('a run an incident keeps keeps its points past 30 days; the others go', async () => {
      const route = await fenced(CIRCLE);
      const { guard, run } = await walking(route.id);
      const other = await walking(route.id);
      const old = (runId: string, guardId: string) =>
        x.inTx(s.c, (tx) =>
          tx.patrolTrackPoint.create({
            data: {
              id: newId(),
              tenantId: s.c.tenantId,
              runId,
              guardAccountId: guardId,
              recordedAt: new Date(dbClock().getTime() - 31 * DAY),
              lat: INSIDE.lat,
              lng: INSIDE.lng,
              receivedAt: dbClock(),
            },
          }),
        );
      const kept = await old(run.id, guard.id);
      const gone = await old(other.run.id, other.guard.id);
      const incidentId = await x.inTx(s.c, (tx) =>
        incidentRow(tx, {
          tenantId: s.c.tenantId,
          unitId: s.home.id,
          reportedById: guard.id,
        }),
      );
      // The reporting guard keeps their own run's track; not a colleague's.
      expect(
        code(
          await x.http(
            'post',
            `/gate/incidents/${incidentId}/evidence`,
            guard.token,
            { kind: 'patrol_track', runId: other.run.id },
          ),
        ),
      ).toEqual({ status: 404, code: 'PATROL_RUN_NOT_FOUND' });
      const linked = (
        await x
          .http('post', `/gate/incidents/${incidentId}/evidence`, guard.token, {
            kind: 'patrol_track',
            runId: run.id,
          })
          .expect(201)
      ).body as { kind: string; runId: string; entryId: null };
      expect(linked).toMatchObject({
        kind: 'patrol_track',
        runId: run.id,
        entryId: null,
      });
      expect(
        fields(
          await x.http(
            'post',
            `/staff/security/incidents/${incidentId}/evidence`,
            supervisor.token,
            { kind: 'patrol_track', runId: run.id, entryId: newId() },
          ),
        ),
      ).toEqual([{ field: 'entryId', code: 'FIELD_NOT_ALLOWED' }]);
      await x.sweep(PATROL_TRACK_PURGE_SWEEP, dbClock());
      const left = await x.inTx(s.c, (tx) =>
        tx.patrolTrackPoint.findMany({
          where: { id: { in: [kept.id, gone.id] } },
          select: { id: true },
        }),
      );
      expect(left).toEqual([{ id: kept.id }]);
      for (const w of [{ guard, run }, other])
        await x.endRunRaw(w.guard, w.run.id).expect(200);
    });
  });
});
