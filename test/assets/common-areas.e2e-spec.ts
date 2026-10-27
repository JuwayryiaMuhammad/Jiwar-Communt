import { err } from '../api/request';
import {
  tagMatches,
  parseTag,
} from '../../src/maintenance/locations/tag-tokens';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Area = {
  id: string;
  kind: string;
  code: string;
  building: string | null;
  facilityId: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  tagIssuedAt: string | null;
};

/**
 * ADR 0064: the common areas. A building names the units' own building, a
 * facility row its facility, once each; the technicians read them, the
 * supervisor and the manager keep them; a tag is shown once and a new one
 * kills the old print.
 */
describe('Assets — common areas', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const post = (body: object, token = s.manager.token) =>
    a.http('post', '/maintenance/areas', token, body);
  const base = (code: string) => ({
    code,
    nameAr: 'منطقة',
    nameEn: 'Area',
  });

  it('a building, an area in it and a facility; each kind takes only its own fields', async () => {
    const building = (
      await post({
        kind: 'building',
        ...base(`B-${Date.now()}`),
        building: ` ${s.building} `,
      }).expect(201)
    ).body as Area;
    expect(building).toMatchObject({
      kind: 'building',
      building: s.building,
      active: true,
      tagIssuedAt: null,
    });
    // One row per building, and the building must be the units'.
    await post({
      kind: 'building',
      ...base(`B2-${Date.now()}`),
      building: s.building,
    })
      .expect(409)
      .expect((r) => {
        expect(r.body).toMatchObject({
          code: 'DUPLICATE_RESOURCE',
          fields: [{ field: 'building' }],
        });
      });
    await post({
      kind: 'area',
      ...base(`X-${Date.now()}`),
      building: 'Nowhere tower',
    })
      .expect(400)
      .expect((r) => {
        expect(err(r).fields).toEqual([
          { field: 'building', code: 'BUILDING_NOT_FOUND' },
        ]);
      });

    const roof = await a.area(s, {
      building: s.building,
      latitude: 30.0444,
      longitude: 31.2357,
    });
    expect(roof).toMatchObject({
      building: s.building,
      latitude: 30.0444,
      longitude: 31.2357,
    });

    const pool = await a.facility(s.c);
    const facility = (
      await post({
        kind: 'facility',
        ...base(`F-${Date.now()}`),
        facilityId: pool.id,
      }).expect(201)
    ).body as Area;
    expect(facility).toMatchObject({ kind: 'facility', facilityId: pool.id });
    await post({
      kind: 'facility',
      ...base(`F2-${Date.now()}`),
      facilityId: pool.id,
    })
      .expect(409)
      .expect((r) => {
        expect(err(r).fields).toEqual([
          expect.objectContaining({ field: 'facilityId' }),
        ]);
      });

    // The shape of each kind.
    await post({ kind: 'building', ...base(`S1-${Date.now()}`) })
      .expect(400)
      .expect((r) => {
        expect(err(r).fields).toEqual([
          { field: 'building', code: 'FIELD_REQUIRED' },
        ]);
      });
    await post({
      kind: 'area',
      ...base(`S2-${Date.now()}`),
      facilityId: pool.id,
      latitude: 30,
    })
      .expect(400)
      .expect((r) => {
        expect(err(r).fields).toEqual([
          { field: 'facilityId', code: 'FIELD_NOT_ALLOWED' },
          { field: 'longitude', code: 'FIELD_REQUIRED' },
        ]);
      });
    await post({
      kind: 'facility',
      ...base(`S3-${Date.now()}`),
      building: s.building,
    })
      .expect(400)
      .expect((r) => {
        expect(err(r).fields).toEqual([
          { field: 'building', code: 'FIELD_NOT_ALLOWED' },
          { field: 'facilityId', code: 'FIELD_REQUIRED' },
        ]);
      });
    // A code is the compound's own: unique.
    await post({ kind: 'area', ...base(roof.code) })
      .expect(409)
      .expect((r) => {
        expect(err(r).fields).toEqual([
          expect.objectContaining({ field: 'code' }),
        ]);
      });
  });

  it('another compound’s facility is a missing relation, never a 500', async () => {
    const other = await a.setUp(0);
    const theirs = await a.facility(other.c);
    await post({
      kind: 'facility',
      ...base(`FX-${Date.now()}`),
      facilityId: theirs.id,
    })
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('RELATED_RESOURCE_MISSING'));
  });

  it('technicians read the areas; only who keeps the register writes them', async () => {
    const area = await a.area(s);
    const tech = s.techs[0].token;
    await a.http('get', `/maintenance/areas/${area.id}`, tech).expect(200);
    const listed = (
      await a
        .http('get', '/maintenance/areas?kind=area&limit=100', tech)
        .expect(200)
    ).body as { data: Area[] };
    expect(listed.data.map((x) => x.id)).toContain(area.id);
    expect(listed.data.every((x) => x.kind === 'area')).toBe(true);
    await post({ kind: 'area', ...base(`T-${Date.now()}`) }, tech).expect(403);
    await a.http('post', `/maintenance/areas/${area.id}/tag`, tech).expect(403);
    // The supervisor keeps them too.
    await post(
      { kind: 'area', ...base(`SV-${Date.now()}`) },
      s.supervisor.token,
    ).expect(201);
  });

  it('an update keeps kind, code and facility; only an area moves building; a retired area takes no tag', async () => {
    const area = await a.area(s);
    await a
      .http('patch', `/maintenance/areas/${area.id}`, s.manager.token, {
        building: s.building,
        nameEn: 'North pump room',
        latitude: 30.1,
        longitude: 31.2,
      })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({
          building: s.building,
          nameEn: 'North pump room',
          latitude: 30.1,
        }),
      );
    await a
      .http('patch', `/maintenance/areas/${area.id}`, s.manager.token, {
        latitude: null,
        longitude: null,
        building: null,
      })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({ building: null, latitude: null }),
      );
    await a
      .http('patch', `/maintenance/areas/${area.id}`, s.manager.token, {
        latitude: 30,
      })
      .expect(400);
    const building = (
      await a
        .http('get', '/maintenance/areas?kind=building', s.manager.token)
        .expect(200)
    ).body as { data: Area[] };
    if (building.data[0])
      await a
        .http(
          'patch',
          `/maintenance/areas/${building.data[0].id}`,
          s.manager.token,
          {
            building: s.building,
          },
        )
        .expect(400)
        .expect((r) =>
          expect(err(r).fields).toEqual([
            { field: 'building', code: 'FIELD_NOT_ALLOWED' },
          ]),
        );
    await a
      .http('patch', `/maintenance/areas/${area.id}`, s.manager.token, {
        code: 'NEW',
      })
      .expect(400);
    await a
      .http('patch', `/maintenance/areas/${area.id}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    await a
      .http('post', `/maintenance/areas/${area.id}/tag`, s.manager.token)
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('COMMON_AREA_RETIRED'));
  });

  it('a tag is shown once, no-store; a new one replaces it, and two at once leave exactly one working', async () => {
    const area = await a.area(s);
    const first = await a
      .http('post', `/maintenance/areas/${area.id}/tag`, s.manager.token)
      .expect(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const code1 = (first.body as { code: string }).code;
    expect(code1.startsWith(`JWL1.${area.id}.`)).toBe(true);
    const stored = () =>
      a.inTenant(s.c, (tx) =>
        tx.commonArea.findUniqueOrThrow({ where: { id: area.id } }),
      );
    const matches = (hash: string | null, code: string) =>
      tagMatches(hash, 'area', s.c.tenantId, area.id, parseTag(code)!.token);
    expect(matches((await stored()).tagHash, code1)).toBe(true);
    // The register shows when, never the tag.
    const view = (
      await a
        .http('get', `/maintenance/areas/${area.id}`, s.manager.token)
        .expect(200)
    ).body as Record<string, unknown>;
    expect(view.tagIssuedAt).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain(parseTag(code1)!.token);

    const [x, y] = await Promise.all([
      a
        .http('post', `/maintenance/areas/${area.id}/tag`, s.manager.token)
        .expect(201),
      a
        .http('post', `/maintenance/areas/${area.id}/tag`, s.manager.token)
        .expect(201),
    ]);
    const hash = (await stored()).tagHash;
    const codes = [x, y].map((r) => (r.body as { code: string }).code);
    expect(codes.filter((c) => matches(hash, c))).toHaveLength(1);
    expect(matches(hash, code1)).toBe(false);
  });

  it('an Idempotency-Key replays the creation', async () => {
    const key = `area-${Date.now()}`;
    const body = { kind: 'area', ...base(`I-${Date.now()}`) };
    const one = await post(body).set('Idempotency-Key', key).expect(201);
    const two = await post(body).set('Idempotency-Key', key).expect(201);
    expect((two.body as { id: string }).id).toBe(
      (one.body as { id: string }).id,
    );
    await post({ ...body, nameEn: 'Other' })
      .set('Idempotency-Key', key)
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('IDEMPOTENCY_CONFLICT'));
  });
});
