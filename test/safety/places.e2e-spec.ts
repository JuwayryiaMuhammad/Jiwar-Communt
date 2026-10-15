import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type PlaceBody } from '../setup/safety';

interface ManagedPlace extends PlaceBody {
  position: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * ADR 0047: every compound starts with the seven places of the mobile
 * contract; the manager renames, orders, retires and adds; the apps list
 * those in service. A place is never deleted, and keeps its key.
 */
describe('Places', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Places Court');
  }, 120_000);

  afterAll(() => h.close());

  const managed = async () =>
    (
      (await x.http('get', '/places', s.manager.token).expect(200)).body as {
        data: ManagedPlace[];
      }
    ).data;

  it('a new compound has the seven defaults, other last, for residents and responders alike', async () => {
    const res = await x
      .http('get', '/community/places', s.alice.token)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = (res.body as { data: PlaceBody[]; nextCursor: null }).data;
    expect(list.map((p) => p.key)).toEqual([
      'main_gate',
      'north_gate',
      'phase_a',
      'phase_b',
      'clubhouse',
      'parking',
      'other',
    ]);
    expect(Object.keys(list[0]).sort()).toEqual(
      ['id', 'key', 'nameAr', 'nameEn'].sort(),
    );
    expect(list[0]).toMatchObject({
      nameEn: 'Main gate',
      nameAr: 'البوابة الرئيسية',
    });
    const guard = await x.guardOnDuty(s.c);
    const fromGuard = (
      (await x.http('get', '/community/places', guard.token).expect(200))
        .body as { data: PlaceBody[] }
    ).data;
    expect(fromGuard).toEqual(list);
    const handler = await x.staff(s.c, ['gate_services.handle']);
    await x.http('get', '/community/places', handler.token).expect(200);
    const other = await x.staff(s.c, ['fines.issue']);
    await x.http('get', '/community/places', other.token).expect(403);
  });

  it('the manager adds, renames, orders and retires; the apps follow', async () => {
    const created = (
      await x
        .http('post', '/places', s.manager.token, {
          nameEn: ' Phase C ',
          nameAr: 'المرحلة ج',
          position: 45,
        })
        .expect(201)
    ).body as ManagedPlace;
    expect(created).toMatchObject({
      key: null,
      nameEn: 'Phase C',
      nameAr: 'المرحلة ج',
      position: 45,
      active: true,
    });
    let keys = Object.keys(await x.places(s.alice));
    expect(keys.indexOf('Phase C')).toBe(keys.indexOf('phase_b') + 1);

    const parking = (await managed()).find((p) => p.key === 'parking')!;
    const renamed = (
      await x
        .http('patch', `/places/${parking.id}`, s.manager.token, {
          nameEn: 'Basement parking',
          position: 5,
        })
        .expect(200)
    ).body as ManagedPlace;
    expect(renamed).toMatchObject({ key: 'parking', position: 5 });
    keys = Object.keys(await x.places(s.alice));
    expect(keys[0]).toBe('parking');

    await x
      .http('patch', `/places/${created.id}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    expect(Object.keys(await x.places(s.alice))).not.toContain('Phase C');
    expect((await managed()).find((p) => p.id === created.id)).toMatchObject({
      active: false,
    });
  });

  it('two places in service never share a name; a retired one frees it', async () => {
    const body = { nameEn: 'Gym entrance', nameAr: 'مدخل الجيم' };
    const first = (
      await x.http('post', '/places', s.manager.token, body).expect(201)
    ).body as ManagedPlace;
    const clash = await x
      .http('post', '/places', s.manager.token, {
        nameEn: 'GYM ENTRANCE',
        nameAr: 'مدخل آخر',
      })
      .expect(409);
    expect(clash.body).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      fields: [{ field: 'nameEn', code: 'DUPLICATE_VALUE' }],
    });
    const clashAr = await x
      .http('post', '/places', s.manager.token, {
        nameEn: 'Another',
        nameAr: 'مدخل الجيم',
      })
      .expect(409);
    expect(clashAr.body).toMatchObject({
      fields: [{ field: 'nameAr', code: 'DUPLICATE_VALUE' }],
    });
    await x
      .http('patch', `/places/${first.id}`, s.manager.token, { active: false })
      .expect(200);
    await x.http('post', '/places', s.manager.token, body).expect(201);
    // Restoring the retired one would make two.
    await x
      .http('patch', `/places/${first.id}`, s.manager.token, { active: true })
      .expect(409);
  });

  it('a place keeps its key and is never deleted, whatever the app writes', async () => {
    const [main] = await managed();
    await expect(
      x.inTx(s.c, (tx) =>
        tx.place.update({ where: { id: main.id }, data: { key: 'other' } }),
      ),
    ).rejects.toThrow(/keeps its key/);
    // The app may not delete at all; the trigger stands behind the grant.
    await expect(
      x.inTx(s.c, (tx) => tx.place.delete({ where: { id: main.id } })),
    ).rejects.toThrow(/permission denied/);
  });

  it('only gate.manage keeps them; names are audited as changed', async () => {
    const guard = await x.guardOnDuty(s.c);
    await x.http('get', '/places', guard.token).expect(403);
    await x
      .http('post', '/places', s.alice.token, { nameEn: 'X', nameAr: 'س' })
      .expect(403);
    const created = (
      await x
        .http('post', '/places', s.manager.token, {
          nameEn: 'Audit lane',
          nameAr: 'ممر المراجعة',
        })
        .expect(201)
    ).body as ManagedPlace;
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'place.created',
      targetId: created.id,
    });
    expect(row.changes).toEqual({
      nameEn: { changed: true },
      nameAr: { changed: true },
      position: { from: null, to: 0 },
      active: { from: null, to: true },
    });
  });
});
