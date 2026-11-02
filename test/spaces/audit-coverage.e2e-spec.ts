import { SPACE_USE_EXPIRY_SWEEP } from '../../src/facilities/spaces/space-use-sweep';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { at, day, spacesHelpers, type SpacesSetUp } from '../setup/spaces';

/**
 * ADR 0084: every audit entry of the spaces, one scenario each — days,
 * ids, codes and counts, never a requester's purpose.
 */
describe('Spaces: audit coverage (ADR 0084)', () => {
  let h: HttpHarness;
  let sp: ReturnType<typeof spacesHelpers>;
  let s: SpacesSetUp;
  const PURPOSE = 'Audit-invisible purpose 5521';

  beforeAll(async () => {
    h = await createHttpHarness();
    sp = spacesHelpers(h);
    s = await sp.setUp('Spaces Audit Court');
  }, 180_000);

  afterAll(() => h.close());

  const rows = (action: string) =>
    sp.inTx(s.c, (tx) =>
      tx.auditLog.findMany({
        where: { action },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );

  it('holidays: created, changed and removed by day', async () => {
    const created = (
      await sp
        .http('post', '/staff/holidays', s.manager.token, {
          day: day(12),
          nameEn: 'Feast',
          nameAr: 'عيد',
        })
        .expect(201)
    ).body as { id: string };
    await sp
      .http('patch', `/staff/holidays/${created.id}`, s.manager.token, {
        stopsWorks: false,
      })
      .expect(200);
    await sp
      .http('delete', `/staff/holidays/${created.id}`, s.manager.token)
      .expect(204);
    expect((await rows('holiday.created'))[0]).toMatchObject({
      actorId: s.manager.id,
      targetType: 'holiday',
      targetId: created.id,
      metadata: { day: day(12), stopsWorks: true },
    });
    expect((await rows('holiday.changed'))[0]).toMatchObject({
      changes: { stopsWorks: { from: true, to: false } },
      metadata: { day: day(12) },
    });
    expect((await rows('holiday.removed'))[0].metadata).toEqual({
      day: day(12),
      stopsWorks: false,
    });
  });

  it('the site map and a floor plan: their images, points, boxes and removal', async () => {
    const first = await sp.image(s.manager, 'site_map');
    await sp
      .http('put', '/staff/site-map/image', s.manager.token, { fileId: first })
      .expect(200);
    await sp
      .http('put', '/staff/site-map/points', s.manager.token, {
        points: [{ kind: 'building', refId: s.buildingId, x: 0.5, y: 0.5 }],
      })
      .expect(200);
    expect((await rows('site_map.image_set'))[0]).toMatchObject({
      targetType: 'tenant',
      targetId: s.c.tenantId,
      metadata: { fileId: first },
    });
    expect((await rows('site_map.points_set'))[0].metadata).toEqual({
      buildings: 1,
      gates: 0,
      facilities: 0,
    });
    const plan = (
      await sp
        .http('post', '/staff/floor-plans', s.manager.token, {
          buildingId: s.buildingId,
          floor: 3,
          fileId: await sp.image(s.manager, 'floor_plan'),
        })
        .expect(201)
    ).body as { id: string };
    await sp
      .http('put', `/staff/floor-plans/${plan.id}/image`, s.manager.token, {
        fileId: await sp.image(s.manager, 'floor_plan'),
      })
      .expect(200);
    await sp
      .http('put', `/staff/floor-plans/${plan.id}/hotspots`, s.manager.token, {
        hotspots: [{ unitId: s.homeA.id, x: 0, y: 0, width: 0.5, height: 0.5 }],
      })
      .expect(200);
    await sp
      .http('delete', `/staff/floor-plans/${plan.id}`, s.manager.token)
      .expect(204);
    expect((await rows('floor_plan.created'))[0]).toMatchObject({
      targetType: 'floor_plan',
      targetId: plan.id,
      metadata: { buildingId: s.buildingId, floor: 3 },
    });
    expect(
      Object.keys(
        (await rows('floor_plan.image_set'))[0].metadata as object,
      ).sort(),
    ).toEqual(['fileId', 'replacedFileId']);
    expect((await rows('floor_plan.hotspots_set'))[0].metadata).toEqual({
      count: 1,
    });
    expect((await rows('floor_plan.removed'))[0].metadata).toEqual({
      buildingId: s.buildingId,
      floor: 3,
    });
  });

  it('use requests: an area opened and closed; a request made, approved, refused, cancelled and expired — never its purpose', async () => {
    const area = await sp.area(s.c, { manager: s.manager });
    const ask = (d: number) =>
      sp
        .askRaw(s.alice, s.homeA.id, area, at(day(d), 10), 2, {
          purpose: PURPOSE,
        })
        .expect(201)
        .then((r) => r.body as { id: string });
    const a = await ask(3);
    const b = await ask(4);
    const c = await ask(5);
    await sp.decide(s.handler, a.id, 'approve').expect(200);
    await sp.decide(s.handler, b.id, 'refuse', 'not_suitable').expect(200);
    await sp.decide(s.handler, a.id, 'cancel', 'area_unavailable').expect(200);
    await sp.sweep(SPACE_USE_EXPIRY_SWEEP, at(day(5), 10, 1));
    await sp
      .http('delete', `/staff/space-use-areas/${area}`, s.manager.token)
      .expect(204);
    expect((await rows('space_use_area.opened'))[0]).toMatchObject({
      targetType: 'common_area',
      targetId: area,
    });
    expect((await rows('space_use_area.closed'))[0].targetId).toBe(area);
    expect((await rows('space_use.requested'))[0]).toMatchObject({
      targetType: 'space_use',
      metadata: {
        commonAreaId: area,
        unitId: s.homeA.id,
        startsAt: at(day(3), 10).toISOString(),
        guests: 10,
      },
    });
    expect((await rows('space_use.approved'))[0].metadata).toEqual({
      commonAreaId: area,
      unitId: s.homeA.id,
    });
    expect((await rows('space_use.refused'))[0].metadata).toEqual({
      commonAreaId: area,
      reasonCode: 'not_suitable',
    });
    expect((await rows('space_use.cancelled'))[0].metadata).toEqual({
      commonAreaId: area,
      from: 'approved',
      side: 'staff',
      reasonCode: 'area_unavailable',
    });
    expect((await rows('space_use.expired')).map((r) => r.targetId)).toContain(
      c.id,
    );
    const all = await sp.inTx(s.c, (tx) =>
      tx.auditLog.findMany({ where: { action: { startsWith: 'space_use' } } }),
    );
    expect(JSON.stringify(all)).not.toContain(PURPOSE);
  });
});
