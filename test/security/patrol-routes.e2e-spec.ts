import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  patrolHelpers,
  type CheckpointBody,
  type RouteBody,
  type Who,
} from '../setup/patrols';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

/**
 * ADR 0052: the routes a patrol walks. A route is walked from a post and
 * asks, in a version, for checkpoints in order, whether the order is
 * enforced, how long it takes and its weekly start times. Changing any of
 * it makes a new version; a checkpoint a route in service walks is not
 * retired.
 */
describe('Patrol routes', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Route Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 120_000);

  afterAll(() => h.close());

  const path = (id: string) => `/staff/security/patrols/routes/${id}`;

  it('made with its first version: the checkpoints in order, the window, the schedule', async () => {
    const a = await x.checkpoint(supervisor, { gateId });
    const b = await x.checkpoint(supervisor, { gateId });
    const route = await x.route(supervisor, { gateId }, [b.id, a.id], {
      ordered: true,
      expectedMinutes: 20,
      schedule: { days: [5, 1, 1], times: ['22:00', '08:00'] },
    });
    expect(route.post.gateId).toBe(gateId);
    expect(route.version).toMatchObject({
      number: 1,
      ordered: true,
      expectedMinutes: 20,
      windowMinutes: 30,
      schedule: { days: [1, 5], times: ['08:00', '22:00'] },
      checkpoints: 2,
    });
    expect(route.stops!.map((p) => [p.position, p.checkpointId])).toEqual([
      [1, b.id],
      [2, a.id],
    ]);
    const read = (
      await x.http('get', path(route.id), supervisor.token).expect(200)
    ).body as RouteBody;
    expect(read).toEqual(route);
  });

  it('a new version supersedes the current one; the names stay', async () => {
    const a = await x.checkpoint(supervisor, { gateId });
    const b = await x.checkpoint(supervisor, { gateId });
    const route = await x.route(supervisor, { gateId }, [a.id]);
    const next = (
      await x
        .versionRaw(supervisor, route.id, {
          checkpointIds: [a.id, b.id],
          ordered: false,
          expectedMinutes: 60,
        })
        .expect(200)
    ).body as RouteBody;
    expect(next.nameEn).toBe(route.nameEn);
    expect(next.version).toMatchObject({
      number: 2,
      expectedMinutes: 60,
      windowMinutes: 60,
      schedule: null,
      checkpoints: 2,
    });
    const versions = await x.inTx(s.c, (tx) =>
      tx.patrolRouteVersion.findMany({
        where: { routeId: route.id },
        orderBy: { number: 'asc' },
      }),
    );
    expect(versions.map((v) => [v.number, v.supersededAt !== null])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('refuses a schedule whose windows overlap, a checkpoint out of service, one twice', async () => {
    const a = await x.checkpoint(supervisor, { gateId });
    const overlap = await x.routeRaw(supervisor, {
      gateId,
      version: {
        checkpointIds: [a.id],
        ordered: false,
        expectedMinutes: 45,
        schedule: { days: [0, 6], times: ['00:10', '23:50'] },
      },
    });
    expect(code(overlap)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(fields(overlap)).toEqual([
      {
        field: 'version.schedule.times',
        code: 'PATROL_SCHEDULE_OVERLAP',
        params: { minutes: 45 },
      },
    ]);
    const route = await x.route(supervisor, { gateId }, [a.id]);
    const twice = await x.versionRaw(supervisor, route.id, {
      checkpointIds: [a.id, a.id],
      ordered: false,
      expectedMinutes: 30,
    });
    expect(fields(twice)).toEqual([
      { field: 'checkpointIds', code: 'DUPLICATE_VALUE' },
    ]);
    const gone = await x.checkpoint(supervisor, { gateId });
    await x
      .http(
        'post',
        `/staff/security/patrols/checkpoints/${gone.id}/retire`,
        supervisor.token,
      )
      .expect(200);
    const retired = await x.versionRaw(supervisor, route.id, {
      checkpointIds: [gone.id],
      ordered: false,
      expectedMinutes: 30,
    });
    expect(fields(retired)).toEqual([
      { field: 'checkpointIds', code: 'CHECKPOINT_NOT_AVAILABLE' },
    ]);
  });

  it('a checkpoint a route in service walks is not retired; once the route is, it may be', async () => {
    const a = await x.checkpoint(supervisor, { gateId });
    const route = await x.route(supervisor, { gateId }, [a.id]);
    const listed = (
      await x
        .http('get', '/staff/security/patrols/checkpoints', supervisor.token)
        .expect(200)
    ).body as { data: CheckpointBody[] };
    expect(listed.data.find((c) => c.id === a.id)).toMatchObject({
      routes: 1,
    });
    const retire = () =>
      x.http(
        'post',
        `/staff/security/patrols/checkpoints/${a.id}/retire`,
        supervisor.token,
      );
    const busy = await retire();
    expect(code(busy)).toEqual({
      status: 409,
      code: 'PATROL_CHECKPOINT_IN_USE',
    });
    expect((busy.body as { params?: unknown }).params).toEqual({ routes: 1 });
    await x
      .http('post', `${path(route.id)}/retire`, supervisor.token)
      .expect(200);
    await retire().expect(200);
  });

  it('renamed in service; retired once, then nothing changes', async () => {
    const a = await x.checkpoint(supervisor, { gateId });
    const route = await x.route(supervisor, { gateId }, [a.id]);
    const renamed = (
      await x
        .http('patch', path(route.id), supervisor.token, { nameEn: 'Gardens' })
        .expect(200)
    ).body as RouteBody;
    expect(renamed.nameEn).toBe('Gardens');
    await x
      .http('post', `${path(route.id)}/retire`, supervisor.token)
      .expect(200);
    for (const res of [
      await x.http('post', `${path(route.id)}/retire`, supervisor.token),
      await x.http('patch', path(route.id), supervisor.token, {
        nameEn: 'Back',
      }),
      await x.versionRaw(supervisor, route.id, {
        checkpointIds: [a.id],
        ordered: false,
        expectedMinutes: 30,
      }),
    ])
      expect(code(res)).toEqual({ status: 409, code: 'PATROL_ROUTE_RETIRED' });
  });

  it('a retry of a creation answers the same route', async () => {
    const a = await x.checkpoint(supervisor, { gateId });
    const body = {
      gateId,
      nameEn: 'Retry round',
      nameAr: 'جولة الإعادة',
      version: { checkpointIds: [a.id], ordered: false, expectedMinutes: 30 },
    };
    const key = { 'Idempotency-Key': `patrol-route-${a.id}` };
    const first = await x.routeRaw(supervisor, body, key).expect(201);
    const again = await x.routeRaw(supervisor, body, key).expect(201);
    expect(again.body).toEqual(first.body);
  });
});
