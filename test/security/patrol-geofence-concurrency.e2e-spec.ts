import { PATROL_GEOFENCE_SWEEP } from '../../src/gate/patrols/patrol-geofence';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type RouteBody, type Who } from '../setup/patrols';

const ROUNDS = 5;
const SECOND = 1000;
const OUTSIDE = { lat: 30.0474, lng: 31.2357, accuracyM: 5 };
const INSIDE = { lat: 30.0444, lng: 31.2357, accuracyM: 5 };

/**
 * ADR 0056, the geofence's races. Two batches of one run take the run FOR
 * UPDATE (after the guard's account FOR SHARE) and walk one after the
 * other; the sweep takes the run FOR UPDATE SKIP LOCKED. Whatever the
 * order: one exit per time outside, one open at most, one flag, one
 * notice to each keeper.
 */
describe('Patrol geofence — races', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;
  let route: RouteBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Geofence Race Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
    const point = await x.checkpoint(supervisor, { gateId });
    route = await x.route(supervisor, { gateId }, [point.id], {
      geofence: { circle: { lat: 30.0444, lng: 31.2357, radiusM: 100 } },
    });
    await x
      .http('patch', '/staff/gate/settings', s.manager.token, {
        geofenceExitMinutes: 1,
      })
      .expect(200);
  }, 180_000);

  afterAll(() => h.close());

  async function walking() {
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    const run = await x.adhoc(guard, route.id);
    const start = new Date(run.startedAt!).getTime();
    const t = (ms: number) => new Date(start + ms).toISOString();
    const send = (points: object[]) =>
      x.http('post', `/gate/patrols/runs/${run.id}/track`, guard.token, {
        points,
      });
    return { guard, run, t, send };
  }
  const exitsOf = (runId: string) =>
    x.inTx(s.c, (tx) => tx.patrolGeofenceExit.findMany({ where: { runId } }));
  const flagsOf = async (runId: string) =>
    (await x.told(s.c, supervisor.id, runId)).filter(
      (n) => n.kind === 'patrol.geofence_exit',
    ).length;

  it('the same batch twice at once (a retry): one exit, flagged once (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { guard, run, t, send } = await walking();
      const batch = [
        { recordedAt: t(-60 * SECOND), ...OUTSIDE },
        { recordedAt: t(10 * SECOND), ...INSIDE },
      ];
      const results = await Promise.all([send(batch), send(batch)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(
        results.map((r) => (r.body as { accepted: number }).accepted).sort(),
      ).toEqual([0, 2]);
      const exits = await exitsOf(run.id);
      expect(exits).toHaveLength(1);
      expect(exits[0].flaggedAt).not.toBeNull();
      expect(await flagsOf(run.id)).toBe(1);
      await x.endRunRaw(guard, run.id).expect(200);
    }
  });

  it('two batches outside at once: one open exit, whichever walks first (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { guard, run, t, send } = await walking();
      const results = await Promise.all([
        send([
          { recordedAt: t(-50 * SECOND), ...OUTSIDE },
          { recordedAt: t(-40 * SECOND), ...OUTSIDE },
        ]),
        send([
          { recordedAt: t(-45 * SECOND), ...OUTSIDE },
          { recordedAt: t(-35 * SECOND), ...OUTSIDE },
        ]),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const exits = await exitsOf(run.id);
      expect(exits).toHaveLength(1);
      expect(exits[0].backAt).toBeNull();
      await x.endRunRaw(guard, run.id).expect(200);
    }
  });

  it('the sweep and a batch that closes the exit at once: flagged once (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { guard, run, t, send } = await walking();
      await send([{ recordedAt: t(-90 * SECOND), ...OUTSIDE }]).expect(200);
      const [, back] = await Promise.all([
        x.sweep(PATROL_GEOFENCE_SWEEP),
        send([{ recordedAt: t(10 * SECOND), ...INSIDE }]),
      ]);
      expect(back.status).toBe(200);
      // A sweep that skipped the run (the batch held it) flags nothing; the
      // batch flagged it then. Either way, once.
      await x.sweep(PATROL_GEOFENCE_SWEEP);
      const [exit] = await exitsOf(run.id);
      expect(exit.backAt).not.toBeNull();
      expect(exit.flaggedAt).not.toBeNull();
      expect(await flagsOf(run.id)).toBe(1);
      await x.endRunRaw(guard, run.id).expect(200);
    }
    // Ten sweeps, each a transaction per compound in the shared test
    // database (160 and more late in a long run): longer than the default.
  }, 120_000);
});
