import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { plate, sticker, vehicleHelpers } from '../setup/vehicles';

/**
 * ADR 0045: a sticker number is issued once in a compound, ever, and a
 * plate holds one active permit. Both hold whatever arrives at once: the
 * sticker by its unique index (answered as a field error, before or at
 * the index alike), the plate by its advisory lock with the unique index
 * behind it. An approval names the version it read, so a plate changed
 * meanwhile is never approved unseen.
 */
describe('Vehicles — stickers and plates under concurrency', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
  }, 120_000);

  afterAll(() => h.close());

  const outcome = (r: { status: number; body: unknown }) => {
    const b = r.body as { code?: string; fields?: unknown };
    return r.status === 200
      ? '200'
      : `${r.status} ${b.code}${b.fields ? ` ${JSON.stringify(b.fields)}` : ''}`;
  };

  const TAKEN =
    '409 DUPLICATE_RESOURCE [{"field":"stickerNumber","code":"DUPLICATE_VALUE"}]';

  async function pendingCars(n: number, plates?: string[]) {
    const cars = [];
    for (let i = 0; i < n; i++) {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      cars.push(
        await v.register(owner, home.id, plates ? { plate: plates[i] } : {}),
      );
    }
    return cars;
  }

  it('one sticker number for six vehicles at once: exactly one gets it', async () => {
    const cars = await pendingCars(6);
    const number = sticker();
    const results = await Promise.all(
      cars.map((c) =>
        v.approveRaw(s.manager, c.id, { stickerNumber: number, version: 1 }),
      ),
    );
    expect(results.map(outcome).sort()).toEqual([
      '200',
      ...Array<string>(5).fill(TAKEN),
    ]);
    expect(
      await v.inTx(s.c, (tx) =>
        tx.vehicleSticker.count({ where: { stickerNumber: number } }),
      ),
    ).toBe(1);
    expect(
      await v.inTx(s.c, (tx) =>
        tx.vehicle.count({ where: { stickerNumber: number } }),
      ),
    ).toBe(1);
  });

  it('a voided sticker is never issued again, not even to its own vehicle', async () => {
    const [car] = await pendingCars(1);
    const number = sticker();
    expect(
      (await v.approveRaw(s.manager, car.id, { stickerNumber: number })).status,
    ).toBe(200);
    const owner = (await v.staffView(s.manager, car.id)).registeredBy.id;
    const token = await h.tokenFor({
      sub: owner,
      tid: s.c.tenantId,
      typ: 'resident',
    });
    await v
      .http('patch', `/vehicles/${car.id}`, token, { plate: plate() })
      .expect(200);
    expect(
      outcome(await v.approveRaw(s.manager, car.id, { stickerNumber: number })),
    ).toBe(TAKEN);
    expect((await v.approveRaw(s.manager, car.id)).status).toBe(200);
  });

  it('one plate on four vehicles approved at once: one active permit', async () => {
    const same = plate();
    const cars = await pendingCars(4, [
      same,
      same.toLowerCase(),
      same.replace(' ', '  '),
      same,
    ]);
    const results = await Promise.all(
      cars.map((c) => v.approveRaw(s.manager, c.id, { version: 1 })),
    );
    expect(results.map(outcome).sort()).toEqual([
      '200',
      ...Array<string>(3).fill('409 VEHICLE_PLATE_ACTIVE'),
    ]);
    const active = await v.inTx(s.c, (tx) =>
      tx.vehicle.count({
        where: { id: { in: cars.map((c) => c.id) }, status: 'active' },
      }),
    );
    expect(active).toBe(1);
  });

  it('the same plate in Arabic-Indic and Western digits is one plate', async () => {
    const [a, b] = await pendingCars(2, ['قبط ٤٤٥٥', 'قبط4455']);
    expect((await v.approveRaw(s.manager, a.id)).status).toBe(200);
    expect(outcome(await v.approveRaw(s.manager, b.id))).toBe(
      '409 VEHICLE_PLATE_ACTIVE',
    );
  });

  it('an approval racing a plate edit never activates the new plate unseen', async () => {
    for (let round = 0; round < 5; round++) {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const car = await v.register(owner, home.id);
      const [approval, edit] = await Promise.all([
        v.approveRaw(s.manager, car.id, { version: 1 }),
        v.http('patch', `/vehicles/${car.id}`, owner.token, { plate: plate() }),
      ]);
      expect(edit.status).toBe(200);
      const after = await v.staffView(s.manager, car.id);
      if (approval.status === 200) {
        // The approval came first: the edit sent it back to pending.
        expect(after).toMatchObject({ status: 'pending', version: 2 });
      } else {
        expect(outcome(approval)).toBe('409 VEHICLE_CHANGED');
        expect(after).toMatchObject({ status: 'pending', version: 2 });
      }
      expect(after.stickerNumber).toBeNull();
    }
  });
});
