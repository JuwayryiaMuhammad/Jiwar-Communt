import { newId } from '../../src/core/common/uuid';
import {
  PATROL_SCHEDULE_SWEEP,
  PATROL_WATCH_SWEEP,
} from '../../src/gate/patrols/patrol-sweeps';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  patrolHelpers,
  type RouteBody,
  type RunBody,
  type Who,
} from '../setup/patrols';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const params = (res: { body: unknown }) =>
  (res.body as { params?: unknown }).params;
const MINUTE = 60_000;

/**
 * ADR 0052: patrol runs. A route's schedule makes its runs 7 days ahead,
 * once; a guard on shift at the post starts one (the first wins) from 15
 * minutes before its start until its window ends, or one of their own;
 * one run under way per guard. A sweep marks runs late (the guards on
 * shift told), missed (the keepers told) and timed out; a run ending
 * short tells the keepers.
 */
describe('Patrol runs', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;
  let route: RouteBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Run Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
    const a = await x.checkpoint(supervisor, { gateId });
    const b = await x.checkpoint(supervisor, { gateId });
    route = await x.route(supervisor, { gateId }, [a.id, b.id], {
      expectedMinutes: 30,
    });
  }, 180_000);

  afterAll(() => h.close());

  /** A guard on shift at `at` (the suite's gate by default). */
  async function onShift(
    at: { gateId?: string; zoneId?: string } = { gateId },
  ) {
    const guard = await x.guard(s.c);
    await x.start(guard, at);
    return guard;
  }
  const scheduledOf = (routeId: string) =>
    x.inTx(s.c, (tx) =>
      tx.patrolRun.findMany({
        where: { routeId, kind: 'scheduled' },
        orderBy: { plannedAt: 'asc' },
      }),
    );

  it('a schedule makes its runs 7 days ahead, once; a new version makes them again; a retirement cancels them', async () => {
    const point = await x.checkpoint(supervisor, { gateId });
    const daily = await x.route(supervisor, { gateId }, [point.id], {
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], times: ['03:00', '15:00'] },
    });
    const made = await scheduledOf(daily.id);
    expect(made.length).toBeGreaterThanOrEqual(14);
    expect(made.length).toBeLessThanOrEqual(16);
    for (const r of made) {
      expect(r.status).toBe('scheduled');
      expect(r.plannedAt.getTime()).toBeGreaterThan(Date.now() - MINUTE);
      expect(r.plannedAt.getTime()).toBeLessThan(Date.now() + 9 * 86_400_000);
      expect(r.windowEndsAt!.getTime() - r.scheduledStart!.getTime()).toBe(
        30 * MINUTE,
      );
    }
    await x.sweep(PATROL_SCHEDULE_SWEEP, new Date());
    expect(await scheduledOf(daily.id)).toHaveLength(made.length);

    const next = (
      await x
        .versionRaw(supervisor, daily.id, {
          checkpointIds: [point.id],
          ordered: false,
          expectedMinutes: 30,
          schedule: { days: [0, 1, 2, 3, 4, 5, 6], times: ['04:00'] },
        })
        .expect(200)
    ).body as RouteBody;
    const after = await scheduledOf(daily.id);
    const old = after.filter((r) => r.versionId === daily.version.id);
    expect(old.map((r) => [r.status, r.cancelReason])).toEqual(
      made.map(() => ['cancelled', 'route_changed']),
    );
    const fresh = after.filter((r) => r.versionId === next.version.id);
    expect(fresh.length).toBeGreaterThanOrEqual(7);
    expect(fresh.every((r) => r.status === 'scheduled')).toBe(true);
    await x.sweep(PATROL_SCHEDULE_SWEEP, new Date());
    expect(await scheduledOf(daily.id)).toHaveLength(after.length);

    await x
      .http(
        'post',
        `/staff/security/patrols/routes/${daily.id}/retire`,
        supervisor.token,
      )
      .expect(200);
    const gone = (await scheduledOf(daily.id)).filter(
      (r) => r.versionId === next.version.id,
    );
    expect(gone.map((r) => [r.status, r.cancelReason])).toEqual(
      fresh.map(() => ['cancelled', 'route_retired']),
    );
  });

  it('started at the post from 15 minutes before its start until its window ends; late after 15 minutes', async () => {
    const guard = await onShift();
    const early = await x.runRow(s.c, route, -20);
    const tooEarly = await x.startRunRaw(guard, early.id);
    expect(code(tooEarly)).toEqual({
      status: 409,
      code: 'PATROL_RUN_NOT_STARTABLE',
    });
    expect(params(tooEarly)).toEqual({ reason: 'too_early' });

    const soon = await x.runRow(s.c, route, -10);
    const started = (await x.startRunRaw(guard, soon.id).expect(200))
      .body as RunBody;
    expect(started).toMatchObject({
      status: 'in_progress',
      late: false,
      guard: { id: guard.id, firstName: expect.any(String) as string },
      ordered: false,
      expectedMinutes: 30,
    });
    expect(started.guard).not.toHaveProperty('fullName');
    expect(started.stops!.map((p) => p.position)).toEqual([1, 2]);
    await x.endRunRaw(guard, soon.id).expect(200);

    const closed = await x.runRow(s.c, route, 40, 30);
    const late = await x.startRunRaw(guard, closed.id);
    expect(params(late)).toEqual({ reason: 'window_closed' });

    const lateRun = await x.runRow(s.c, route, 20);
    const lateStart = (await x.startRunRaw(guard, lateRun.id).expect(200))
      .body as RunBody;
    expect(lateStart.late).toBe(true);
    await x.endRunRaw(guard, lateRun.id).expect(200);
  });

  it('the first start wins; one run under way per guard; another post’s run is not found; off shift is 403', async () => {
    const one = await onShift();
    const two = await onShift();
    const run = await x.runRow(s.c, route, 0);
    await x.startRunRaw(one, run.id).expect(200);
    expect(code(await x.startRunRaw(two, run.id))).toEqual({
      status: 409,
      code: 'PATROL_ALREADY_STARTED',
    });
    const other = await x.runRow(s.c, route, 1);
    expect(code(await x.startRunRaw(one, other.id))).toEqual({
      status: 409,
      code: 'PATROL_RUN_ALREADY_LIVE',
    });
    expect(code(await x.adhocRaw(one, route.id))).toEqual({
      status: 409,
      code: 'PATROL_RUN_ALREADY_LIVE',
    });
    const elsewhere = await onShift({ gateId: (await x.g.gate(s.c)).id });
    expect(code(await x.startRunRaw(elsewhere, other.id))).toEqual({
      status: 404,
      code: 'PATROL_RUN_NOT_FOUND',
    });
    expect(
      code(
        await x.http('get', `/gate/patrols/runs/${run.id}`, elsewhere.token),
      ),
    ).toEqual({ status: 404, code: 'PATROL_RUN_NOT_FOUND' });
    // The guard on shift at the post sees it, the starter by first name.
    const seen = (
      await x.http('get', `/gate/patrols/runs/${run.id}`, two.token).expect(200)
    ).body as RunBody;
    expect(seen.guard).toEqual({
      id: one.id,
      firstName: expect.any(String) as string,
    });
    const off = await x.guard(s.c);
    expect(code(await x.startRunRaw(off, other.id))).toEqual({
      status: 403,
      code: 'NO_OPEN_SHIFT',
    });
    await x.endRunRaw(one, run.id).expect(200);
  });

  it('a run of my own: of a route in service from my post, on its current version', async () => {
    const guard = await onShift();
    const run = await x.adhoc(guard, route.id);
    expect(run).toMatchObject({
      kind: 'adhoc',
      status: 'in_progress',
      scheduledStart: null,
      windowEndsAt: null,
      checkpointsTotal: 2,
    });
    expect(run.plannedAt).toBe(run.startedAt);
    await x.endRunRaw(guard, run.id).expect(200);
    const far = await x.g.gate(s.c);
    const point = await x.checkpoint(supervisor, { gateId: far.id });
    const there = await x.route(supervisor, { gateId: far.id }, [point.id]);
    expect(code(await x.adhocRaw(guard, there.id))).toEqual({
      status: 404,
      code: 'PATROL_ROUTE_NOT_FOUND',
    });
  });

  it('ended short by the guard: incomplete, the keepers told; again is 409', async () => {
    const guard = await onShift();
    const run = await x.adhoc(guard, route.id);
    const ended = (await x.endRunRaw(guard, run.id).expect(200))
      .body as RunBody;
    expect(ended).toMatchObject({
      status: 'incomplete',
      endReason: 'guard',
      scannedCount: 0,
    });
    for (const keeper of [supervisor, s.manager])
      expect(await x.told(s.c, keeper.id, run.id)).toEqual([
        { kind: 'patrol.incomplete', params: { reason: 'guard' } },
      ]);
    expect(await x.told(s.c, guard.id, run.id)).toEqual([]);
    expect(code(await x.endRunRaw(guard, run.id))).toEqual({
      status: 409,
      code: 'PATROL_RUN_NOT_LIVE',
    });
  });

  it('a shift’s end ends the run under way, incomplete; the keepers are told', async () => {
    const guard = await onShift();
    const run = await x.adhoc(guard, route.id);
    await x.endRaw(guard).expect(200);
    expect(await x.runOf(s.c, run.id)).toMatchObject({
      status: 'incomplete',
      endReason: 'shift_ended',
    });
    expect(await x.told(s.c, supervisor.id, run.id)).toEqual([
      { kind: 'patrol.incomplete', params: { reason: 'shift_ended' } },
    ]);
  });

  describe('the watch', () => {
    it('late once: the guards on shift at the post are told, the keepers are not', async () => {
      const guard = await onShift();
      const run = await x.runRow(s.c, route, 16, 60);
      await x.sweep(PATROL_WATCH_SWEEP, new Date());
      const row = await x.runOf(s.c, run.id);
      expect(row.status).toBe('scheduled');
      expect(row.lateAt).not.toBeNull();
      expect(await x.told(s.c, guard.id, run.id)).toEqual([
        { kind: 'patrol.late', params: {} },
      ]);
      expect(await x.told(s.c, supervisor.id, run.id)).toEqual([]);
      await x.sweep(PATROL_WATCH_SWEEP, new Date());
      expect((await x.runOf(s.c, run.id)).lateAt).toEqual(row.lateAt);
      expect(await x.told(s.c, guard.id, run.id)).toHaveLength(1);
    });

    it('missed when its window ends: the keepers are told; at a post out of service it is cancelled, nobody told', async () => {
      const run = await x.runRow(s.c, route, 31, 30);
      const closedGate = await x.g.gate(s.c);
      const point = await x.checkpoint(supervisor, { gateId: closedGate.id });
      const there = await x.route(supervisor, { gateId: closedGate.id }, [
        point.id,
      ]);
      const away = await x.runRow(s.c, there, 31, 30);
      await x
        .http('patch', `/gates/${closedGate.id}`, s.manager.token, {
          status: 'inactive',
        })
        .expect(200);
      await x.sweep(PATROL_WATCH_SWEEP, new Date());
      expect(await x.runOf(s.c, run.id)).toMatchObject({ status: 'missed' });
      expect(await x.told(s.c, supervisor.id, run.id)).toEqual([
        { kind: 'patrol.missed', params: {} },
      ]);
      expect(await x.runOf(s.c, away.id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'post_out_of_service',
        cancelledById: null,
      });
      expect(await x.told(s.c, supervisor.id, away.id)).toEqual([]);
    });

    it('timed out at twice its expected minutes: closed, the keepers told', async () => {
      const guard = await onShift();
      const shift = (
        await x.http('get', '/gate/shifts/current', guard.token).expect(200)
      ).body as { id: string };
      const startedAt = new Date(Date.now() - 61 * MINUTE);
      const id = newId();
      await x.inTx(s.c, (tx) =>
        tx.patrolRun.create({
          data: {
            id,
            tenantId: s.c.tenantId,
            routeId: route.id,
            versionId: route.version.id,
            gateId,
            kind: 'adhoc',
            plannedAt: startedAt,
            status: 'in_progress',
            guardAccountId: guard.id,
            shiftId: shift.id,
            startedAt,
            checkpointsTotal: 2,
          },
        }),
      );
      await x.sweep(PATROL_WATCH_SWEEP, new Date());
      expect(await x.runOf(s.c, id)).toMatchObject({
        status: 'timed_out',
        endReason: null,
      });
      expect(await x.told(s.c, supervisor.id, id)).toEqual([
        { kind: 'patrol.incomplete', params: { reason: 'timed_out' } },
      ]);
    });
  });

  it('the management cancels a scheduled run with a code; nothing else; guard_reports.read reads but does not cancel', async () => {
    const run = await x.runRow(s.c, route, -120);
    const path = `/staff/security/patrols/runs/${run.id}`;
    expect(
      code(await x.http('post', `${path}/cancel`, supervisor.token, {})),
    ).toEqual({ status: 400, code: 'REASON_REQUIRED' });
    const cancelled = (
      await x
        .http('post', `${path}/cancel`, supervisor.token, {
          reasonCode: 'not_needed',
        })
        .expect(200)
    ).body as RunBody & { cancelledBy: { id: string; fullName?: string } };
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelReason: 'not_needed',
      cancelledBy: {
        id: supervisor.id,
        fullName: expect.any(String) as string,
      },
    });
    const again = await x.http('post', `${path}/cancel`, supervisor.token, {
      reasonCode: 'other',
    });
    expect(code(again)).toEqual({ status: 409, code: 'PATROL_RUN_CLOSED' });
    expect(params(again)).toEqual({ status: 'cancelled' });

    const reader = await x.staff(s.c, ['guard_reports.read']);
    const listed = (
      await x
        .http(
          'get',
          `/staff/security/patrols/runs?routeId=${route.id}`,
          reader.token,
        )
        .expect(200)
    ).body as { data: RunBody[] };
    expect(listed.data.map((r) => r.id)).toContain(run.id);
    await x.http('get', path, reader.token).expect(200);
    expect(
      (
        await x.http('post', `${path}/cancel`, reader.token, {
          reasonCode: 'other',
        })
      ).status,
    ).toBe(403);
  });

  it('the management reads the guard by full name; the board shows my post’s runs and routes', async () => {
    const guard = await onShift();
    const run = await x.runRow(s.c, route, -5);
    const board = (
      await x.http('get', '/gate/patrols', guard.token).expect(200)
    ).body as {
      live: RunBody | null;
      runs: RunBody[];
      routes: { id: string; checkpoints: number }[];
    };
    expect(board.live).toBeNull();
    expect(board.runs.map((r) => r.id)).toContain(run.id);
    expect(board.routes).toContainEqual(
      expect.objectContaining({ id: route.id, checkpoints: 2 }),
    );
    await x.startRunRaw(guard, run.id).expect(200);
    const live = (await x.http('get', '/gate/patrols', guard.token).expect(200))
      .body as { live: RunBody | null };
    expect(live.live?.id).toBe(run.id);
    const staff = (
      await x
        .http('get', `/staff/security/patrols/runs/${run.id}`, s.manager.token)
        .expect(200)
    ).body as RunBody;
    expect(staff.guard).toEqual({
      id: guard.id,
      fullName: expect.any(String) as string,
    });
    const mine = (
      await x.http('get', '/gate/patrols/runs', guard.token).expect(200)
    ).body as { data: RunBody[] };
    expect(mine.data.map((r) => r.id)).toEqual([run.id]);
    await x.endRunRaw(guard, run.id).expect(200);
  });
});
