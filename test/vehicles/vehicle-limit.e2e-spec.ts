import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { newId } from '../../src/core/common/uuid';
import { vehicleHelpers, type Who } from '../setup/vehicles';

/**
 * ADR 0045: a unit holds at most the compound's `maxVehiclesPerUnit`
 * pending or active vehicles, whatever arrives at once. The count is read
 * and the vehicle written under the unit's vehicles lock; these races run
 * for real and count rows afterwards.
 */
describe('Vehicles — the per-unit limit under concurrency', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
  }, 120_000);

  afterAll(() => h.close());

  const codes = (results: { status: number; body: unknown }[]) =>
    results
      .map((r) =>
        `${r.status} ${(r.body as { code?: string }).code ?? ''}`.trim(),
      )
      .sort();

  const held = (unitId: string) =>
    v.inTx(s.c, (tx) =>
      tx.vehicle.count({
        where: { unitId, status: { in: ['pending', 'active'] } },
      }),
    );

  it('eight registrations by two people at once into a limit of four: exactly four', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const member = await v.family(s.c, home.id, owner);
    const people: Who[] = [owner, member];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        v.registerRaw(people[i % 2], home.id),
      ),
    );
    expect(codes(results)).toEqual([
      ...Array<string>(4).fill('201'),
      ...Array<string>(4).fill('409 VEHICLE_LIMIT_REACHED'),
    ]);
    expect(await held(home.id)).toBe(4);
    const refused = results.find((r) => r.status === 409)!;
    expect((refused.body as { params: unknown }).params).toEqual({ max: 4 });
  });

  it('a rejected vehicle frees its place; its new plate and a registration race for it: one wins', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const cars = [];
    for (let i = 0; i < 4; i++) cars.push(await v.register(owner, home.id));
    await v
      .http('post', `/staff/vehicles/${cars[0].id}/reject`, s.manager.token, {
        version: 1,
        reasonCode: 'other',
      })
      .expect(200);
    expect(await held(home.id)).toBe(3);
    const [edit, registration] = await Promise.all([
      v.http('patch', `/vehicles/${cars[0].id}`, owner.token, {
        plate: 'ZZ 1',
      }),
      v.registerRaw(owner, home.id),
    ]);
    expect(
      [edit.status, registration.status].filter((x) => x === 409),
    ).toHaveLength(1);
    expect(
      [edit, registration]
        .filter((r) => r.status === 409)
        .map((r) => (r.body as { code: string }).code),
    ).toEqual(['VEHICLE_LIMIT_REACHED']);
    expect(await held(home.id)).toBe(4);
  });

  it('the same Idempotency-Key twice at once registers one vehicle', async () => {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const key = newId();
    const body = { plate: 'IDEM 77' };
    const [a, b] = await Promise.all([
      v.registerRaw(owner, home.id, body, { 'Idempotency-Key': key }),
      v.registerRaw(owner, home.id, body, { 'Idempotency-Key': key }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(await held(home.id)).toBe(1);
    if (a.status === 201 && b.status === 201)
      expect((a.body as { id: string }).id).toBe((b.body as { id: string }).id);
  });

  it('a lower limit leaves what a unit holds, and refuses more', async () => {
    const c = await v.x.compound('Lower limit');
    const manager = await v.who(c, c.managerId, 'manager');
    const home = await v.unit(c);
    const owner = await v.owner(c, home.id);
    await v.register(owner, home.id);
    await v.register(owner, home.id);
    await v
      .http('patch', '/staff/vehicle-settings', manager.token, {
        maxVehiclesPerUnit: 1,
      })
      .expect(200);
    expect(
      (
        await v
          .http('get', `/units/${home.id}/vehicles`, owner.token)
          .expect(200)
      ).body,
    ).toMatchObject({ data: [{}, {}] });
    expect((await v.registerRaw(owner, home.id)).body).toMatchObject({
      code: 'VEHICLE_LIMIT_REACHED',
      params: { max: 1 },
    });
  });
});
