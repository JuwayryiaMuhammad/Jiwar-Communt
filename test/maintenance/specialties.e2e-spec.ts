import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0033: specialties, which of them can handle a category, and which a
 * technician has. Readable by dispatch, written by the manager (specialties
 * and categories) or by dispatchers (technicians).
 */
describe('Maintenance — specialties', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(2);
  }, 60_000);

  afterAll(() => h.close());

  const list = async () =>
    (
      (
        await d
          .http('get', '/maintenance/specialties', s.manager.token)
          .expect(200)
      ).body as { data: { id: string; key: string; active: boolean }[] }
    ).data;
  const byKey = async (key: string) =>
    (await list()).find((r) => r.key === key)!;

  it('the five defaults exist; a supervisor reads them, only the manager writes', async () => {
    expect((await list()).map((r) => r.key).sort()).toEqual([
      'ac',
      'carpentry',
      'electrical',
      'general',
      'plumbing',
    ]);
    await d
      .http('get', '/maintenance/specialties', s.supervisor.token)
      .expect(200);
    await d
      .http('post', '/maintenance/specialties', s.supervisor.token, {
        key: 'pool',
        nameAr: 'مسبح',
        nameEn: 'Pool',
      })
      .expect(403);
  });

  it('create, duplicate key, rename and retire (the key never changes)', async () => {
    const created = await d
      .http('post', '/maintenance/specialties', s.manager.token, {
        key: 'pool',
        nameAr: 'مسبح',
        nameEn: 'Pool',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      key: 'pool',
      nameEn: 'Pool',
      active: true,
    });
    const dup = await d
      .http('post', '/maintenance/specialties', s.manager.token, {
        key: 'pool',
        nameAr: 'x',
        nameEn: 'x',
      })
      .expect(409);
    expect(dup.body).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      fields: [{ field: 'key' }],
    });
    const id = (created.body as { id: string }).id;
    const patched = await d
      .http('patch', `/maintenance/specialties/${id}`, s.manager.token, {
        nameEn: 'Swimming pool',
        active: false,
      })
      .expect(200);
    expect(patched.body).toMatchObject({
      key: 'pool',
      nameEn: 'Swimming pool',
      active: false,
    });
  });

  it('a category’s specialties are replaced as a set, and show on the category', async () => {
    const plumbing = await byKey('plumbing');
    const electrical = await byKey('electrical');
    const categories = (
      (
        await d
          .http('get', '/maintenance/categories', s.manager.token)
          .expect(200)
      ).body as { data: { id: string; key: string; specialtyIds: string[] }[] }
    ).data;
    const category = categories.find((c) => c.key === 'general')!;
    // Seeded: its namesake.
    expect(category.specialtyIds).toEqual([(await byKey('general')).id]);
    await d
      .http(
        'put',
        `/maintenance/categories/${category.id}/specialties`,
        s.manager.token,
        {
          specialtyIds: [plumbing.id, electrical.id],
        },
      )
      .expect(204);
    const after = (
      (await d.http('get', '/maintenance/categories', s.manager.token))
        .body as {
        data: { key: string; specialtyIds: string[] }[];
      }
    ).data.find((c) => c.key === 'general')!;
    expect([...after.specialtyIds].sort()).toEqual(
      [plumbing.id, electrical.id].sort(),
    );
    // Empty means any technician can take it.
    await d
      .http(
        'put',
        `/maintenance/categories/${category.id}/specialties`,
        s.manager.token,
        {
          specialtyIds: [],
        },
      )
      .expect(204);
    const empty = (
      (await d.http('get', '/maintenance/categories', s.manager.token))
        .body as {
        data: { key: string; specialtyIds: string[] }[];
      }
    ).data.find((c) => c.key === 'general')!;
    expect(empty.specialtyIds).toEqual([]);
  });

  it('refuses a retired, unknown or foreign specialty, naming the index', async () => {
    const other = await d.setUp(1);
    const foreign = (
      (await d.http('get', '/maintenance/specialties', other.manager.token))
        .body as {
        data: { id: string; key: string }[];
      }
    ).data[0].id;
    const retired = (await list()).find((r) => !r.active)!;
    const live = await byKey('ac');
    const res = await d
      .http(
        'put',
        `/maintenance/technicians/${s.techs[0].id}/specialties`,
        s.supervisor.token,
        {
          specialtyIds: [live.id, foreign, retired.id],
        },
      )
      .expect(400);
    expect(res.body).toMatchObject({
      fields: [
        { field: 'specialtyIds.1', code: 'SPECIALTY_NOT_AVAILABLE' },
        { field: 'specialtyIds.2', code: 'SPECIALTY_NOT_AVAILABLE' },
      ],
    });
  });

  it('dispatchers set a technician’s specialties; the list shows the active ones; a switched-off row comes back', async () => {
    const tech = s.techs[0];
    const plumbing = await byKey('plumbing');
    const ac = await byKey('ac');
    await d
      .http(
        'put',
        `/maintenance/technicians/${tech.id}/specialties`,
        s.supervisor.token,
        {
          specialtyIds: [plumbing.id, ac.id],
        },
      )
      .expect(204);
    const listed = async () =>
      (
        (
          await d
            .http('get', '/maintenance/technicians', s.supervisor.token)
            .expect(200)
        ).body as { data: { id: string; specialties: { key: string }[] }[] }
      ).data
        .find((t) => t.id === tech.id)!
        .specialties.map((r) => r.key);
    expect(await listed()).toEqual(['ac', 'plumbing']);
    await d
      .http(
        'put',
        `/maintenance/technicians/${tech.id}/specialties`,
        s.supervisor.token,
        {
          specialtyIds: [ac.id],
        },
      )
      .expect(204);
    expect(await listed()).toEqual(['ac']);
    // The row was switched off, not deleted; adding it back reuses it.
    const rows = await d.inTenant(s.c, (tx) =>
      tx.technicianSpecialty.findMany({ where: { accountId: tech.id } }),
    );
    expect(rows.map((r) => r.active).sort()).toEqual([false, true]);
    await d
      .http(
        'put',
        `/maintenance/technicians/${tech.id}/specialties`,
        s.supervisor.token,
        {
          specialtyIds: [plumbing.id, ac.id],
        },
      )
      .expect(204);
    expect(await listed()).toEqual(['ac', 'plumbing']);
    // A retired specialty counts for nobody.
    await d
      .http(
        'patch',
        `/maintenance/specialties/${plumbing.id}`,
        s.manager.token,
        {
          active: false,
        },
      )
      .expect(200);
    expect(await listed()).toEqual(['ac']);
    await d
      .http(
        'patch',
        `/maintenance/specialties/${plumbing.id}`,
        s.manager.token,
        {
          active: true,
        },
      )
      .expect(200);
  });

  it('only a technician has specialties: a guard, a resident or an unknown id is TECHNICIAN_NOT_FOUND', async () => {
    const ac = await byKey('ac');
    for (const id of [s.owner.id, s.supervisor.id, s.manager.id]) {
      const res = await d
        .http(
          'put',
          `/maintenance/technicians/${id}/specialties`,
          s.supervisor.token,
          {
            specialtyIds: [ac.id],
          },
        )
        .expect(404);
      expect(res.body).toMatchObject({ code: 'TECHNICIAN_NOT_FOUND' });
    }
  });

  it('two replacements at once never interleave: the result is one of the two sets', async () => {
    const tech = s.techs[1];
    const [a, b, c] = [
      (await byKey('plumbing')).id,
      (await byKey('electrical')).id,
      (await byKey('carpentry')).id,
    ];
    for (let i = 0; i < 5; i++) {
      const results = await Promise.all([
        d.http(
          'put',
          `/maintenance/technicians/${tech.id}/specialties`,
          s.supervisor.token,
          {
            specialtyIds: [a, b],
          },
        ),
        d.http(
          'put',
          `/maintenance/technicians/${tech.id}/specialties`,
          s.manager.token,
          {
            specialtyIds: [c],
          },
        ),
      ]);
      expect(results.map((r) => r.status)).toEqual([204, 204]);
      const active = (
        await d.inTenant(s.c, (tx) =>
          tx.technicianSpecialty.findMany({
            where: { accountId: tech.id, active: true },
          }),
        )
      )
        .map((r) => r.specialtyId)
        .sort();
      expect([[a, b].sort(), [c]]).toContainEqual(active);
    }
  });
});
