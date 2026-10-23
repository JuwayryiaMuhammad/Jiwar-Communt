import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  LICENCE_PHOTO_SWEEP,
  PERMIT_EXPIRING_SWEEP,
} from '../../src/gate/vehicles/vehicle-sweeps';
import {
  day,
  plate,
  sticker,
  vehicleHelpers,
  type StaffVehicleBody,
  type VehicleBody,
  type Who,
} from '../setup/vehicles';
import { daysLater, dbDate } from '../setup/compound-clock';

const DAY = 86_400_000;

/**
 * ADR 0045: a unit's vehicles, kept by the people who live there (and its
 * adult members), approved by the staff with a sticker and a permit. A new
 * plate waits again; colour, model and type do not.
 */
describe('Vehicles', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    // Many vehicles on one home here; the limit has its own suite.
    await v
      .http('patch', '/staff/vehicle-settings', s.manager.token, {
        maxVehiclesPerUnit: 20,
      })
      .expect(200);
  }, 120_000);

  afterAll(() => h.close());

  const code = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });

  const list = async (as: Who, unitId: string) =>
    (
      (await v.http('get', `/units/${unitId}/vehicles`, as.token).expect(200))
        .body as { data: VehicleBody[] }
    ).data;

  describe('who keeps a unit’s vehicles', () => {
    it('whoever lives there and the adult members register; a landlord does not; another unit is not found', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const member = await v.family(s.c, home.id, owner);
      const rented = await v.unit(s.c);
      const landlord = await v.landlord(s.c, rented.id);
      const tenant = await v.tenant(s.c, rented.id);

      for (const [who, unitId] of [
        [owner, home.id],
        [member, home.id],
        [tenant, rented.id],
      ] as const)
        expect((await v.registerRaw(who, unitId)).status).toBe(201);

      expect(code(await v.registerRaw(landlord, rented.id))).toEqual({
        status: 403,
        code: 'VEHICLES_NOT_ALLOWED',
      });
      expect(code(await v.registerRaw(owner, rented.id))).toEqual({
        status: 404,
        code: 'UNIT_NOT_FOUND',
      });
      // The member registered without any grant from the primary.
      expect(await list(member, home.id)).toHaveLength(2);
    });

    it('a new vehicle is pending, numbered V-, and the registrant may manage it', async () => {
      const mine = await v.register(s.alice, s.home.id, {
        plate: ' abc   123 ',
        type: 'motorcycle',
      });
      expect(mine).toMatchObject({
        plate: 'ABC 123',
        type: 'motorcycle',
        permitStatus: 'pending',
        permitValidUntil: null,
        stickerNumber: null,
        rejectionReason: null,
        licencePhotoUrl: null,
        canManage: true,
      });
      expect(mine.reference).toMatch(/^V-\d{4,}$/);
      expect(Object.keys(mine).sort()).toEqual(
        [
          'id',
          'reference',
          'plate',
          'makeAndModel',
          'color',
          'type',
          'permitStatus',
          'permitValidUntil',
          'stickerNumber',
          'rejectionReason',
          'licencePhotoUrl',
          'canManage',
          'createdAt',
        ].sort(),
      );
      const again = await v.http('get', `/vehicles/${mine.id}`, s.alice.token);
      expect(again.status).toBe(200);
      expect(again.headers['cache-control']).toBe('no-store');
    });

    it('refuses a plate that is not one, and fields out of range', async () => {
      const res = await v.registerRaw(s.alice, s.home.id, {
        plate: 'AB-12',
        makeAndModel: ' ',
        color: 'x'.repeat(31),
      });
      expect(res.status).toBe(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        { field: 'plate', code: 'INVALID_FORMAT', params: { maxLength: 12 } },
        {
          field: 'makeAndModel',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 60 },
        },
        { field: 'color', code: 'INVALID_LENGTH', params: { min: 1, max: 30 } },
      ]);
    });
  });

  describe('the licence photo', () => {
    it('the unit’s vehicle keepers and the staff see it; another unit does not', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const member = await v.family(s.c, home.id, owner);
      const photo = await v.licence(owner);
      const car = await v.register(owner, home.id, {
        licencePhotoFileId: photo,
      });
      expect(car.licencePhotoUrl).toEqual(expect.stringContaining('http'));
      const seen = (
        await v.http('get', `/vehicles/${car.id}`, member.token).expect(200)
      ).body as VehicleBody;
      expect(seen.licencePhotoUrl).toEqual(expect.stringContaining('http'));
      expect(seen.canManage).toBe(false);
      expect(
        (
          await v
            .http('get', `/staff/vehicles/${car.id}`, s.manager.token)
            .expect(200)
        ).body,
      ).toMatchObject({
        licencePhotoUrl: expect.stringContaining('http') as string,
      });
      // The file left its uploader: not even the owner reaches it directly.
      expect((await v.http('get', `/files/${photo}`, owner.token)).status).toBe(
        404,
      );
      const other = await v.unit(s.c);
      const stranger = await v.owner(s.c, other.id);
      expect(
        code(await v.http('get', `/vehicles/${car.id}`, stranger.token)),
      ).toEqual({ status: 404, code: 'VEHICLE_NOT_FOUND' });
    });

    it('a photo that is not the caller’s finalized licence is not available', async () => {
      const otherHome = await v.unit(s.c);
      const other = await v.owner(s.c, otherHome.id);
      const theirs = await v.licence(other);
      const res = await v.registerRaw(s.alice, s.home.id, {
        licencePhotoFileId: theirs,
      });
      expect(res.status).toBe(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        { field: 'licencePhotoFileId', code: 'FILE_NOT_AVAILABLE' },
      ]);
    });

    it('replacing the photo deletes the old file; the status stays', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const first = await v.licence(owner);
      const car = await v.register(owner, home.id, {
        licencePhotoFileId: first,
      });
      await v
        .approveRaw(s.manager, car.id)
        .then((r) => expect(r.status).toBe(200));
      const second = await v.licence(owner);
      const res = await v
        .http('patch', `/vehicles/${car.id}`, owner.token, {
          licencePhotoFileId: second,
        })
        .expect(200);
      expect((res.body as VehicleBody).permitStatus).toBe('active');
      const old = await v.inTx(s.c, (tx) =>
        tx.storedFile.findUnique({ where: { id: first } }),
      );
      expect(old === null || old.deletedAt !== null).toBe(true);
      expect((await v.row(s.c, car.id)).licencePhotoFileId).toBe(second);
    });
  });

  describe('editing', () => {
    async function activeCar(owner: Who, unitId: string) {
      const car = await v.register(owner, unitId);
      expect((await v.approveRaw(s.manager, car.id)).status).toBe(200);
      return car;
    }

    it('a new plate sends an active vehicle back to pending: its sticker void, its version up', async () => {
      const car = await activeCar(s.alice, s.home.id);
      const before = await v.staffView(s.manager, car.id);
      const res = await v
        .http('patch', `/vehicles/${car.id}`, s.alice.token, { plate: plate() })
        .expect(200);
      expect(res.body).toMatchObject({
        permitStatus: 'pending',
        stickerNumber: null,
        permitValidUntil: null,
      });
      const after = await v.staffView(s.manager, car.id);
      expect(after.version).toBe(before.version + 1);
      // The sticker stays issued to it, never to be issued again.
      expect(
        await v.inTx(s.c, (tx) =>
          tx.vehicleSticker.count({
            where: { stickerNumber: before.stickerNumber! },
          }),
        ),
      ).toBe(1);
    });

    it('the same plate typed differently, colour, model and type keep the status', async () => {
      const car = await v.register(s.alice, s.home.id, { plate: 'قبط 1234' });
      expect((await v.approveRaw(s.manager, car.id)).status).toBe(200);
      const res = await v
        .http('patch', `/vehicles/${car.id}`, s.alice.token, {
          plate: 'ق ب ط ١٢٣٤',
          color: 'Black',
          makeAndModel: 'Kia Cerato',
          type: 'van',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        plate: 'ق ب ط ١٢٣٤',
        color: 'Black',
        makeAndModel: 'Kia Cerato',
        type: 'van',
        permitStatus: 'active',
      });
      expect((await v.staffView(s.manager, car.id)).version).toBe(1);
    });

    it('only the registrant or the unit’s primary edits or removes; the primary may change a member’s', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const one = await v.family(s.c, home.id, owner);
      const two = await v.family(s.c, home.id, owner);
      const car = await v.register(one, home.id);
      expect(
        code(
          await v.http('patch', `/vehicles/${car.id}`, two.token, {
            color: 'Red',
          }),
        ),
      ).toEqual({ status: 403, code: 'VEHICLE_ACTION_NOT_ALLOWED' });
      expect(
        code(await v.http('delete', `/vehicles/${car.id}`, two.token)),
      ).toEqual({ status: 403, code: 'VEHICLE_ACTION_NOT_ALLOWED' });
      await v
        .http('patch', `/vehicles/${car.id}`, owner.token, { color: 'Red' })
        .expect(200);
      await v
        .http('patch', `/vehicles/${car.id}`, one.token, { color: 'Blue' })
        .expect(200);
    });

    it('a rejected vehicle given a new plate waits again; the same plate stays rejected', async () => {
      const car = await v.register(s.alice, s.home.id);
      const { version } = await v.staffView(s.manager, car.id);
      const rejected = await v
        .http('post', `/staff/vehicles/${car.id}/reject`, s.manager.token, {
          version,
          reasonCode: 'licence_missing',
        })
        .expect(200);
      expect(rejected.body).toMatchObject({
        status: 'rejected',
        rejectionReason: 'licence_missing',
      });
      expect(
        (
          (
            await v
              .http('get', `/vehicles/${car.id}`, s.alice.token)
              .expect(200)
          ).body as VehicleBody
        ).rejectionReason,
      ).toBe('licence_missing');
      await v
        .http('patch', `/vehicles/${car.id}`, s.alice.token, { color: 'Green' })
        .expect(200)
        .expect((r) =>
          expect((r.body as VehicleBody).permitStatus).toBe('rejected'),
        );
      await v
        .http('patch', `/vehicles/${car.id}`, s.alice.token, { plate: plate() })
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({
            permitStatus: 'pending',
            rejectionReason: null,
          }),
        );
    });
  });

  describe('removal', () => {
    it('is final: the vehicle is gone for its people and void for the staff', async () => {
      const car = await v.register(s.alice, s.home.id);
      expect((await v.approveRaw(s.manager, car.id)).status).toBe(200);
      await v
        .http('delete', `/vehicles/${car.id}?reasonCode=sold`, s.alice.token)
        .expect(204);
      expect(
        code(await v.http('get', `/vehicles/${car.id}`, s.alice.token)),
      ).toEqual({ status: 404, code: 'VEHICLE_NOT_FOUND' });
      expect((await list(s.alice, s.home.id)).map((x) => x.id)).not.toContain(
        car.id,
      );
      expect(await v.staffView(s.manager, car.id)).toMatchObject({
        status: 'removed',
        permitStatus: 'removed',
        stickerNumber: null,
        permitValidUntil: null,
      });
      expect(
        (await v.http('get', `/staff/vehicles/${car.id}`, s.manager.token))
          .body,
      ).toMatchObject({ removalSide: 'resident', removalReason: 'sold' });
      expect(
        code(
          await v.http('patch', `/vehicles/${car.id}`, s.alice.token, {
            color: 'Red',
          }),
        ),
      ).toEqual({ status: 404, code: 'VEHICLE_NOT_FOUND' });
    });

    it('without a reason it is `other`; the staff remove with theirs', async () => {
      const one = await v.register(s.alice, s.home.id);
      await v.http('delete', `/vehicles/${one.id}`, s.alice.token).expect(204);
      expect((await v.row(s.c, one.id)).removalReason).toBe('other');
      const two = await v.register(s.alice, s.home.id);
      await v
        .http('post', `/staff/vehicles/${two.id}/remove`, s.manager.token, {
          reasonCode: 'permit_revoked',
        })
        .expect(204);
      expect(await v.row(s.c, two.id)).toMatchObject({
        status: 'removed',
        removalSide: 'staff',
        removalReason: 'permit_revoked',
        removedById: s.manager.id,
      });
      expect(
        code(
          await v.http(
            'post',
            `/staff/vehicles/${two.id}/remove`,
            s.manager.token,
            {
              reasonCode: 'other',
            },
          ),
        ),
      ).toEqual({ status: 409, code: 'VEHICLE_INVALID_TRANSITION' });
    });

    it('the licence photo is deleted 30 days after the removal, the vehicle stays', async () => {
      const photo = await v.licence(s.alice);
      const car = await v.register(s.alice, s.home.id, {
        licencePhotoFileId: photo,
      });
      await v.http('delete', `/vehicles/${car.id}`, s.alice.token).expect(204);
      await v.sweep(LICENCE_PHOTO_SWEEP, new Date(Date.now() + 29 * DAY));
      expect((await v.row(s.c, car.id)).licencePhotoFileId).toBe(photo);
      await v.sweep(LICENCE_PHOTO_SWEEP, new Date(Date.now() + 31 * DAY));
      expect((await v.row(s.c, car.id)).licencePhotoFileId).toBeNull();
      const file = await v.inTx(s.c, (tx) =>
        tx.storedFile.findUnique({ where: { id: photo } }),
      );
      expect(file === null || file.deletedAt !== null).toBe(true);
    });
  });

  describe('the staff decide', () => {
    it('approve: a sticker (upper-cased) and a last day after today, within 731 days', async () => {
      const car = await v.register(s.alice, s.home.id);
      for (const until of [day(0), day(800)])
        expect(
          (await v.approveRaw(s.manager, car.id, { permitValidUntil: until }))
            .body,
        ).toMatchObject({
          code: 'VALIDATION_FAILED',
          fields: [
            {
              field: 'permitValidUntil',
              code: 'PERMIT_DATE_OUT_OF_RANGE',
              params: { min: day(1), max: day(731) },
            },
          ],
        });
      const number = sticker().toLowerCase();
      const res = await v.approveRaw(s.manager, car.id, {
        stickerNumber: number,
        permitValidUntil: day(200),
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'active',
        permitStatus: 'active',
        stickerNumber: number.toUpperCase(),
        permitValidUntil: day(200),
        decidedBy: { id: s.manager.id },
      });
      expect(code(await v.approveRaw(s.manager, car.id))).toEqual({
        status: 409,
        code: 'VEHICLE_INVALID_TRANSITION',
      });
      // The registrant is told; the staff member who acted is not.
      const told = (who: Who) =>
        v
          .notifications(s.c, who.id, 'vehicle.approved')
          .then((n) => n.filter((x) => x.targetId === car.id));
      expect(await told(s.alice)).toHaveLength(1);
      expect(await told(s.manager)).toHaveLength(0);
    });

    it('a decision names the version it read: a plate changed meanwhile is VEHICLE_CHANGED', async () => {
      const car = await v.register(s.alice, s.home.id);
      const seen = await v.staffView(s.manager, car.id);
      await v
        .http('patch', `/vehicles/${car.id}`, s.alice.token, { plate: plate() })
        .expect(200);
      const res = await v.approveRaw(s.manager, car.id, {
        version: seen.version,
      });
      expect(res.body).toMatchObject({
        code: 'VEHICLE_CHANGED',
        params: { version: seen.version + 1 },
      });
      expect(
        code(
          await v.http(
            'post',
            `/staff/vehicles/${car.id}/reject`,
            s.manager.token,
            {
              version: seen.version,
              reasonCode: 'other',
            },
          ),
        ),
      ).toEqual({ status: 409, code: 'VEHICLE_CHANGED' });
    });

    it('reject tells the registrant with the reason’s code', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const car = await v.register(owner, home.id);
      await v
        .http('post', `/staff/vehicles/${car.id}/reject`, s.manager.token, {
          version: 1,
          reasonCode: 'plate_mismatch',
        })
        .expect(200);
      const told = await v.notifications(s.c, owner.id, 'vehicle.rejected');
      expect(told.map((n) => n.params)).toEqual([{ reason: 'plate_mismatch' }]);
    });

    it('renew: a new last day, not before the current one', async () => {
      const car = await v.register(s.alice, s.home.id);
      await v.approveRaw(s.manager, car.id, { permitValidUntil: day(100) });
      expect(
        (
          await v.http(
            'post',
            `/staff/vehicles/${car.id}/renew`,
            s.manager.token,
            {
              permitValidUntil: day(50),
            },
          )
        ).body,
      ).toMatchObject({
        fields: [
          {
            field: 'permitValidUntil',
            code: 'PERMIT_DATE_OUT_OF_RANGE',
            params: { min: day(100), max: day(731) },
          },
        ],
      });
      await v
        .http('post', `/staff/vehicles/${car.id}/renew`, s.manager.token, {
          permitValidUntil: day(400),
        })
        .expect(200)
        .expect((r) =>
          expect((r.body as StaffVehicleBody).permitValidUntil).toBe(day(400)),
        );
    });

    it('expires_soon within 30 days of the last day, expired after it — read, never stored', async () => {
      const car = await v.register(s.alice, s.home.id);
      await v.approveRaw(s.manager, car.id, { permitValidUntil: day(31) });
      const status = async () =>
        (
          (
            await v
              .http('get', `/vehicles/${car.id}`, s.alice.token)
              .expect(200)
          ).body as VehicleBody
        ).permitStatus;
      expect(await status()).toBe('active');
      const setUntil = (d: string) =>
        v.inTx(s.c, (tx) =>
          tx.vehicle.update({
            where: { id: car.id },
            data: { permitValidUntil: dbDate(d) },
          }),
        );
      await setUntil(day(30));
      expect(await status()).toBe('expires_soon');
      await setUntil(day(0));
      expect(await status()).toBe('expires_soon');
      await setUntil(day(-1));
      expect(await status()).toBe('expired');
      const listed = (
        await v
          .http('get', `/staff/vehicles?status=expired`, s.manager.token)
          .expect(200)
      ).body as { data: StaffVehicleBody[] };
      expect(listed.data.map((x) => x.id)).toContain(car.id);
    });

    it('the queue: pending, oldest first; a plate matches by its key', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const first = await v.register(owner, home.id, { plate: 'ق ب ط ٧٧٨٨' });
      const second = await v.register(owner, home.id);
      const queue = (
        await v
          .http(
            'get',
            `/staff/vehicles?status=pending&unitCode=${encodeURIComponent(home.code)}`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: StaffVehicleBody[] };
      expect(queue.data.map((x) => x.id)).toEqual([first.id, second.id]);
      expect(queue.data[0]).toMatchObject({
        unitCode: home.code,
        registeredBy: { id: owner.id },
        version: 1,
      });
      const byPlate = (
        await v
          .http(
            'get',
            `/staff/vehicles?plate=${encodeURIComponent('قبط7788')}`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: StaffVehicleBody[] };
      expect(byPlate.data.map((x) => x.id)).toEqual([first.id]);
    });
  });

  describe('the permit-expiring notice', () => {
    it('once per last day, to the registrant; a renewal arms it again', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const car = await v.register(owner, home.id);
      await v.approveRaw(s.manager, car.id, { permitValidUntil: day(40) });
      await v.sweep(PERMIT_EXPIRING_SWEEP);
      expect(
        await v.notifications(s.c, owner.id, 'vehicle.permit_expiring'),
      ).toHaveLength(0);
      await v.sweep(PERMIT_EXPIRING_SWEEP, daysLater(11));
      await v.sweep(PERMIT_EXPIRING_SWEEP, daysLater(12));
      expect(
        await v.notifications(s.c, owner.id, 'vehicle.permit_expiring'),
      ).toHaveLength(1);
      await v
        .http('post', `/staff/vehicles/${car.id}/renew`, s.manager.token, {
          permitValidUntil: day(45),
        })
        .expect(200);
      await v.sweep(PERMIT_EXPIRING_SWEEP, daysLater(16));
      const told = await v.notifications(
        s.c,
        owner.id,
        'vehicle.permit_expiring',
      );
      expect(told).toHaveLength(2);
      expect(told.every((n) => JSON.stringify(n.params) === '{}')).toBe(true);
    });
  });

  describe('settings', () => {
    it('the manager reads and changes the three numbers', async () => {
      const c = await v.x.compound('Vehicle settings');
      const manager = await v.who(c, c.managerId, 'manager');
      expect(
        (
          await v
            .http('get', '/staff/vehicle-settings', manager.token)
            .expect(200)
        ).body,
      ).toEqual({
        maxVehiclesPerUnit: 4,
        visitorParkingMaxHours: 12,
        maxActiveVisitorParkingBookings: 3,
      });
      await v
        .http('patch', '/staff/vehicle-settings', manager.token, {
          maxVehiclesPerUnit: 2,
        })
        .expect(200)
        .expect((r) => expect(r.body).toMatchObject({ maxVehiclesPerUnit: 2 }));
    });
  });
});
