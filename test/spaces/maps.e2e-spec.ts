import { newId } from '../../src/core/common/uuid';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { spacesHelpers, type SpacesSetUp } from '../setup/spaces';

interface MapBody {
  image: { url: string } | null;
  points: {
    kind: string;
    refId: string;
    nameEn: string;
    x: number;
    y: number;
  }[];
}
interface PlanBody {
  id: string;
  buildingId: string;
  floor: number;
  hotspots: number;
  image: { url: string } | null;
  units: {
    unitId: string;
    unitCode: string;
    x: number;
    y: number;
    width: number;
    height: number;
    misplaced: boolean;
  }[];
}

const code = (res: { body: unknown }) => (res.body as { code: string }).code;
const fields = (res: { body: unknown }) =>
  (res.body as { fields: unknown[] }).fields;

/**
 * ADR 0084: the site map (one image, a point a building, gate or facility)
 * and the floor plans (one image a building's floor, a box a unit inside
 * it). A household sees its own floor's plan with its own box only.
 */
describe('Spaces: the site map and the floor plans (ADR 0084)', () => {
  let h: HttpHarness;
  let sp: ReturnType<typeof spacesHelpers>;
  let s: SpacesSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    sp = spacesHelpers(h);
    s = await sp.setUp('Maps Court');
  }, 180_000);

  afterAll(() => h.close());

  it('the map: an image first, then points on its buildings and facilities, each once and the compound’s; the apps see active places', async () => {
    const c = await sp.setUp('Map Points Court');
    const early = await sp
      .http('put', '/staff/site-map/points', c.manager.token, { points: [] })
      .expect(409);
    expect(code(early)).toBe('SITE_MAP_NOT_SET');
    const first = await sp.image(c.manager, 'site_map');
    await sp
      .http('put', '/staff/site-map/image', c.manager.token, { fileId: first })
      .expect(200);
    const court = await sp.facility(c.c, c.manager);
    const bad = await sp
      .http('put', '/staff/site-map/points', c.manager.token, {
        points: [
          { kind: 'building', refId: c.buildingId, x: 0.2, y: 0.3 },
          { kind: 'building', refId: c.buildingId, x: 0.4, y: 0.3 },
          { kind: 'gate', refId: newId(), x: 0.1, y: 0.1 },
          { kind: 'facility', refId: court, x: 1.5, y: 0.1 },
        ],
      })
      .expect(400);
    expect(fields(bad)).toEqual([
      {
        field: 'points.3.x',
        code: 'INVALID_NUMBER',
        params: { min: 0, max: 1 },
      },
    ]);
    const dup = await sp
      .http('put', '/staff/site-map/points', c.manager.token, {
        points: [
          { kind: 'building', refId: c.buildingId, x: 0.2, y: 0.3 },
          { kind: 'building', refId: c.buildingId, x: 0.4, y: 0.3 },
          { kind: 'gate', refId: newId(), x: 0.1, y: 0.1 },
        ],
      })
      .expect(400);
    expect(fields(dup)).toEqual([
      { field: 'points.1.refId', code: 'DUPLICATE_VALUE' },
      { field: 'points.2.refId', code: 'MAP_PLACE_NOT_AVAILABLE' },
    ]);
    const set = (
      await sp
        .http('put', '/staff/site-map/points', c.manager.token, {
          points: [
            { kind: 'building', refId: c.buildingId, x: 0.2, y: 0.3 },
            { kind: 'facility', refId: court, x: 0.123456, y: 1 },
          ],
        })
        .expect(200)
    ).body as MapBody;
    expect(set.points.map((x) => [x.kind, x.x, x.y])).toEqual([
      ['building', 0.2, 0.3],
      ['facility', 0.12346, 1],
    ]);
    // A new image keeps the points; the old file goes.
    const second = await sp.image(c.manager, 'site_map');
    await sp
      .http('put', '/staff/site-map/image', c.manager.token, { fileId: second })
      .expect(200);
    expect(
      (
        await sp.inTx(c.c, (tx) =>
          tx.storedFile.findUniqueOrThrow({ where: { id: first } }),
        )
      ).deletedAt,
    ).not.toBeNull();
    await sp.inTx(c.c, (tx) =>
      tx.facility.update({ where: { id: court }, data: { active: false } }),
    );
    const residents = (
      await sp.http('get', '/site-map', c.alice.token).expect(200)
    ).body as MapBody;
    expect(residents.image).not.toBeNull();
    expect(residents.points.map((x) => x.kind)).toEqual(['building']);
    const staff = (
      await sp.http('get', '/staff/site-map', c.manager.token).expect(200)
    ).body as MapBody;
    expect(staff.points).toHaveLength(2);
  });

  it('a floor plan: one a floor, boxes inside the image for the floor’s own units, each once', async () => {
    const fileId = await sp.image(s.manager, 'floor_plan');
    const plan = (
      await sp
        .http('post', '/staff/floor-plans', s.manager.token, {
          buildingId: s.buildingId,
          floor: 3,
          fileId,
        })
        .expect(201)
    ).body as PlanBody;
    const twice = await sp
      .http('post', '/staff/floor-plans', s.manager.token, {
        buildingId: s.buildingId,
        floor: 3,
        fileId: await sp.image(s.manager, 'floor_plan'),
      })
      .expect(409);
    expect([code(twice), (twice.body as { params: unknown }).params]).toEqual([
      'FLOOR_PLAN_EXISTS',
      { planId: plan.id },
    ]);
    const elsewhere = await sp.unit(s.c, 'A');
    const bad = await sp
      .http('put', `/staff/floor-plans/${plan.id}/hotspots`, s.manager.token, {
        hotspots: [
          { unitId: s.homeA.id, x: 0.5, y: 0.5, width: 0.6, height: 0.1 },
          { unitId: elsewhere.id, x: 0, y: 0, width: 0.1, height: 0.1 },
          { unitId: s.homeA.id, x: 0, y: 0, width: 0.1, height: 0.1 },
        ],
      })
      .expect(400);
    expect(fields(bad)).toEqual([
      { field: 'hotspots.0', code: 'HOTSPOT_OUTSIDE_IMAGE' },
      { field: 'hotspots.1.unitId', code: 'UNIT_NOT_ON_FLOOR' },
      { field: 'hotspots.2.unitId', code: 'DUPLICATE_VALUE' },
    ]);
    // Five decimals: a box that ends on the edge once rounded is inside
    // (0.33333 + 0.66667).
    const set = (
      await sp
        .http(
          'put',
          `/staff/floor-plans/${plan.id}/hotspots`,
          s.manager.token,
          {
            hotspots: [
              {
                unitId: s.homeA.id,
                x: 0.333334,
                y: 0,
                width: 0.666666,
                height: 0.5,
              },
              { unitId: s.homeB.id, x: 0, y: 0.5, width: 0.3, height: 0.5 },
            ],
          },
        )
        .expect(200)
    ).body as PlanBody;
    expect(set.hotspots).toBe(2);
    expect(set.units.every((u) => !u.misplaced)).toBe(true);
    expect(set.units.every((u) => u.x + u.width <= 1)).toBe(true);
  });

  it('a household sees its own floor’s plan with its own box only — never another unit; another household’s unit is not found', async () => {
    const mine = (
      await sp
        .http('get', `/units/${s.homeA.id}/floor-plan`, s.alice.token)
        .expect(200)
    ).body as Record<string, unknown>;
    expect(Object.keys(mine).sort()).toEqual(
      ['box', 'buildingName', 'floor', 'image', 'unitCode'].sort(),
    );
    expect(mine).toMatchObject({ floor: 3, unitCode: s.homeA.code });
    expect(JSON.stringify(mine)).not.toContain(s.homeB.id);
    expect(JSON.stringify(mine)).not.toContain(s.homeB.code);
    const theirs = await sp
      .http('get', `/units/${s.homeB.id}/floor-plan`, s.alice.token)
      .expect(404);
    expect(code(theirs)).toBe('UNIT_NOT_FOUND');
  });

  it('a unit moved to another floor shows misplaced to the staff; its household then sees its new floor’s plan, or none', async () => {
    const c = await sp.setUp('Maps Move Court');
    const plan = (
      await sp
        .http('post', '/staff/floor-plans', c.manager.token, {
          buildingId: c.buildingId,
          floor: 3,
          fileId: await sp.image(c.manager, 'floor_plan'),
        })
        .expect(201)
    ).body as PlanBody;
    await sp
      .http('put', `/staff/floor-plans/${plan.id}/hotspots`, c.manager.token, {
        hotspots: [
          { unitId: c.homeA.id, x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        ],
      })
      .expect(200);
    await sp.inTx(c.c, (tx) =>
      tx.unit.update({ where: { id: c.homeA.id }, data: { floor: 4 } }),
    );
    const staff = (
      await sp
        .http('get', `/staff/floor-plans/${plan.id}`, c.manager.token)
        .expect(200)
    ).body as PlanBody;
    expect(staff.units).toMatchObject([
      { unitId: c.homeA.id, misplaced: true },
    ]);
    const none = await sp
      .http('get', `/units/${c.homeA.id}/floor-plan`, c.alice.token)
      .expect(404);
    expect(code(none)).toBe('FLOOR_PLAN_NOT_FOUND');
    // Boxed on its new floor's plan, its stale box goes.
    const upper = (
      await sp
        .http('post', '/staff/floor-plans', c.manager.token, {
          buildingId: c.buildingId,
          floor: 4,
          fileId: await sp.image(c.manager, 'floor_plan'),
        })
        .expect(201)
    ).body as PlanBody;
    await sp
      .http('put', `/staff/floor-plans/${upper.id}/hotspots`, c.manager.token, {
        hotspots: [
          { unitId: c.homeA.id, x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
        ],
      })
      .expect(200);
    expect(
      (
        (await sp.http('get', `/staff/floor-plans/${plan.id}`, c.manager.token))
          .body as PlanBody
      ).units,
    ).toEqual([]);
    const seen = (
      await sp
        .http('get', `/units/${c.homeA.id}/floor-plan`, c.alice.token)
        .expect(200)
    ).body as { floor: number; box: unknown };
    expect(seen).toMatchObject({
      floor: 4,
      box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
    });
    await sp
      .http('delete', `/staff/floor-plans/${upper.id}`, c.manager.token)
      .expect(204);
    await sp
      .http('get', `/units/${c.homeA.id}/floor-plan`, c.alice.token)
      .expect(404);
  });

  it.each([1, 2, 3])(
    'round %i: two plans for one floor at once — one is made',
    async (round) => {
      const floor = 10 + round;
      const [x, y] = await Promise.all(
        [1, 2].map(async () =>
          sp.http('post', '/staff/floor-plans', s.manager.token, {
            buildingId: s.buildingId,
            floor,
            fileId: await sp.image(s.manager, 'floor_plan'),
          }),
        ),
      );
      expect([x.status, y.status].sort()).toEqual([201, 409]);
    },
  );

  it('the database keeps a box inside the image and a point on exactly its place', async () => {
    const write = (sql: string) =>
      sp.inTx(s.c, (tx) => tx.$executeRawUnsafe(sql));
    await expect(
      write(
        `INSERT INTO floor_plan_units (tenant_id, plan_id, unit_id, x, y, width, height)
         SELECT p.tenant_id, p.id, u.id, 0.5, 0, 0.9, 0.1
           FROM floor_plans p JOIN units u ON u.tenant_id = p.tenant_id
          WHERE NOT EXISTS (SELECT 1 FROM floor_plan_units f WHERE f.unit_id = u.id)
          LIMIT 1`,
      ),
    ).rejects.toThrow(/floor_plan_units_inside/);
    await expect(
      write(
        `INSERT INTO site_map_points (id, tenant_id, kind, x, y, created_at)
         VALUES (gen_random_uuid(), '${s.c.tenantId}', 'gate', 0.1, 0.1, now())`,
      ),
    ).rejects.toThrow(/site_map_points/);
  });
});
