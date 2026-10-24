import { newId } from '../../src/core/common/uuid';
import { PATROL_TRACK_PURGE_SWEEP } from '../../src/gate/patrols/patrol-track.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type RouteBody, type Who } from '../setup/patrols';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const MINUTE = 60_000;
// eslint-disable-next-line no-restricted-syntax -- a real 24 h: track points are kept for a duration in ms
const DAY = 86_400_000;

/**
 * ADR 0052: where a guard walked. Batches during a run and up to 30
 * minutes after it; a point already sent adds nothing; read by
 * patrols.manage and by the guard on their own runs; deleted after 30
 * days.
 */
describe('Patrol track points', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;
  let route: RouteBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Track Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
    const point = await x.checkpoint(supervisor, { gateId });
    route = await x.route(supervisor, { gateId }, [point.id]);
  }, 180_000);

  afterAll(() => h.close());

  async function walking() {
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    return { guard, run: await x.adhoc(guard, route.id) };
  }
  const send = (as: Who, runId: string, points: object[]) =>
    x.http('post', `/gate/patrols/runs/${runId}/track`, as.token, { points });
  const at = (msAgo: number, lat = 30.0444) => ({
    recordedAt: new Date(Date.now() - msAgo).toISOString(),
    lat,
    lng: 31.2357,
    accuracyM: 6,
  });

  it('a batch is recorded once; sent again it adds nothing; the guard reads their own', async () => {
    const { guard, run } = await walking();
    const batch = [at(2000), at(1000, 30.0445)];
    expect((await send(guard, run.id, batch).expect(200)).body).toEqual({
      accepted: 2,
      rejected: 0,
    });
    expect((await send(guard, run.id, batch).expect(200)).body).toEqual({
      accepted: 0,
      rejected: 0,
    });
    const mine = (
      await x
        .http('get', `/gate/patrols/runs/${run.id}/track`, guard.token)
        .expect(200)
    ).body as { data: { lat: number }[]; nextCursor: null };
    expect(mine.data.map((p) => p.lat)).toEqual([30.0444, 30.0445]);
    expect(mine.nextCursor).toBeNull();
  });

  it('a point outside the run’s lifetime is dropped; the rest are kept', async () => {
    const { guard, run } = await walking();
    const res = await send(guard, run.id, [
      at(0),
      at(10 * MINUTE),
      at(-10 * MINUTE),
      at(1000),
    ]).expect(200);
    expect(res.body).toEqual({ accepted: 2, rejected: 2 });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.patrolTrackPoint.count({ where: { runId: run.id } }),
      ),
    ).toBe(2);
    // Every point out: nothing kept, still not an error.
    expect(
      (await send(guard, run.id, [at(10 * MINUTE)]).expect(200)).body,
    ).toEqual({ accepted: 0, rejected: 1 });
  });

  it('a malformed batch is refused whole: no point, or more than 100', async () => {
    const { guard, run } = await walking();
    for (const points of [
      [],
      Array.from({ length: 101 }, (_, i) => at(i * 10)),
    ])
      expect(code(await send(guard, run.id, points))).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    expect(
      code(
        await send(guard, run.id, [{ recordedAt: 'soon', lat: 30, lng: 31 }]),
      ),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.patrolTrackPoint.count({ where: { runId: run.id } }),
      ),
    ).toBe(0);
  });

  it('after the run: up to 30 minutes from its offline queue, then refused', async () => {
    const { guard, run } = await walking();
    const point = at(0);
    await x.endRunRaw(guard, run.id).expect(200);
    await send(guard, run.id, [point]).expect(200);
    // A run of theirs that ended 40 minutes ago.
    const shift = await x.inTx(s.c, (tx) =>
      tx.guardShift.findFirstOrThrow({
        where: { guardAccountId: guard.id, endedAt: null },
      }),
    );
    const startedAt = new Date(Date.now() - 80 * MINUTE);
    const old = newId();
    await x.inTx(s.c, (tx) =>
      tx.patrolRun.create({
        data: {
          id: old,
          tenantId: s.c.tenantId,
          routeId: route.id,
          versionId: route.version.id,
          gateId,
          kind: 'adhoc',
          plannedAt: startedAt,
          status: 'incomplete',
          endReason: 'guard',
          guardAccountId: guard.id,
          shiftId: shift.id,
          startedAt,
          endedAt: new Date(Date.now() - 40 * MINUTE),
          checkpointsTotal: 1,
        },
      }),
    );
    expect(code(await send(guard, old, [at(45 * MINUTE)]))).toEqual({
      status: 409,
      code: 'PATROL_RUN_NOT_LIVE',
    });
  });

  it('read by patrols.manage and the guard on their own runs; never by another guard or guard_reports.read', async () => {
    const { guard, run } = await walking();
    await send(guard, run.id, [at(0)]).expect(200);
    const colleague = await x.guard(s.c);
    await x.start(colleague, { gateId });
    expect(
      code(
        await x.http(
          'get',
          `/gate/patrols/runs/${run.id}/track`,
          colleague.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'PATROL_RUN_NOT_FOUND' });
    expect(code(await send(colleague, run.id, [at(0)]))).toEqual({
      status: 404,
      code: 'PATROL_RUN_NOT_FOUND',
    });
    const staff = `/staff/security/patrols/runs/${run.id}/track`;
    const read = (await x.http('get', staff, supervisor.token).expect(200))
      .body as { data: unknown[] };
    expect(read.data).toHaveLength(1);
    const reader = await x.staff(s.c, ['guard_reports.read']);
    expect((await x.http('get', staff, reader.token)).status).toBe(403);
    // The run's detail never carries the track.
    const detail = await x
      .http('get', `/staff/security/patrols/runs/${run.id}`, reader.token)
      .expect(200);
    expect(JSON.stringify(detail.body)).not.toContain('accuracyM');
  });

  it('deleted 30 days after it was recorded, not before', async () => {
    const { guard, run } = await walking();
    const row = (msAgo: number) =>
      x.inTx(s.c, (tx) =>
        tx.patrolTrackPoint.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            runId: run.id,
            guardAccountId: guard.id,
            recordedAt: new Date(Date.now() - msAgo),
            lat: 30,
            lng: 31,
            receivedAt: new Date(),
          },
        }),
      );
    // eslint-disable-next-line test-clock/day-multiple -- a real 29 × 24 h: track points are kept 30 × 24 h, in ms
    const kept = await row(29 * DAY);
    // eslint-disable-next-line test-clock/day-multiple -- a real 30 × 24 h: track points are kept 30 × 24 h, in ms
    const gone = await row(30 * DAY + MINUTE);
    await x.sweep(PATROL_TRACK_PURGE_SWEEP, new Date());
    const left = await x.inTx(s.c, (tx) =>
      tx.patrolTrackPoint.findMany({ where: { runId: run.id } }),
    );
    expect(left.map((p) => p.id)).toEqual([kept.id]);
    expect(left.map((p) => p.id)).not.toContain(gone.id);
  });
});
