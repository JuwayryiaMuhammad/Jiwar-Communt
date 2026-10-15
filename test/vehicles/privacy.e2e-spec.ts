import { AccountsService } from '../../src/core/accounts/accounts.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { eraseNow } from '../setup/erasure';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { day, vehicleHelpers, type Who } from '../setup/vehicles';

/**
 * ADR 0045: an account's vehicles, visitor parking, appeals and reports
 * when it goes. Losing `vehicles` on a unit removes the vehicles it
 * registered there (the primary is told); losing the right to invite
 * cancels its bookings; an erasure clears what it wrote and keeps what the
 * unit's records are. Its export holds its own.
 */
describe('Vehicles — privacy', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;
  let areaId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    areaId = await v.area(s.c, s.manager, 50);
  }, 120_000);

  afterAll(() => h.close());

  async function household() {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const member = await v.family(s.c, home.id, owner);
    return { home, owner, member };
  }

  const row = (id: string) => v.row(s.c, id);
  const told = (who: Who) =>
    v.notifications(s.c, who.id, 'vehicle.registrant_left');

  describe('the registrant no longer holds vehicles on the unit', () => {
    it('a member removed: their vehicles there are removed by the system, the primary told; the others stay', async () => {
      const { home, owner, member } = await household();
      const theirs = await v.register(member, home.id);
      const active = await v.register(member, home.id);
      await v
        .approveRaw(s.manager, active.id)
        .then((r) => expect(r.status).toBe(200));
      const primarys = await v.register(owner, home.id);
      await v.x.as(s.c, { id: owner.id, type: 'resident' }, () =>
        h.moduleRef.get(HouseholdsService).removeMember(member.memberId, {
          code: 'relation_ended',
          text: 'No longer',
        }),
      );
      for (const id of [theirs.id, active.id])
        expect(await row(id)).toMatchObject({
          status: 'removed',
          removalSide: 'system',
          removalReason: 'registrant_left',
          removedById: null,
          stickerNumber: null,
        });
      expect((await row(primarys.id)).status).toBe('pending');
      expect((await told(owner)).map((n) => n.targetId).sort()).toEqual(
        [theirs.id, active.id].sort(),
      );
      expect((await told(owner))[0].params).toEqual({});
    });

    it('an occupancy ended: the same, and the one who left is not told about their own car', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const tenantHome = await v.unit(s.c);
      const created = await v.x.resident(s.c, [home.id, tenantHome.id]);
      const mover = await v.who(s.c, created.id, 'resident');
      const here = await v.register(mover, home.id);
      const there = await v.register(mover, tenantHome.id);
      const occupancy = (await v.x.occupancies(s.c, home.id)).find(
        (o) => o.accountId === mover.id && o.status === 'active',
      )!;
      await v.x.asManager(s.c, () =>
        v.x.residents.endOccupancy(occupancy.id, {
          code: 'moved_out',
          text: 'Moved out',
        }),
      );
      expect((await row(here.id)).removalReason).toBe('registrant_left');
      expect((await row(there.id)).status).toBe('pending');
      expect((await told(owner)).map((n) => n.targetId)).toEqual([here.id]);
      expect(await told(mover)).toEqual([]);
    });

    it('deactivated: every vehicle they registered is removed', async () => {
      const { home, owner, member } = await household();
      const car = await v.register(member, home.id);
      await v.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(member.id, { status: 'inactive' }),
      );
      expect(await row(car.id)).toMatchObject({
        status: 'removed',
        removalReason: 'registrant_left',
      });
      expect((await told(owner)).map((n) => n.targetId)).toEqual([car.id]);
    });

    it('the primary who leaves is told nobody: they were the one told', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const car = await v.register(owner, home.id);
      await v.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(owner.id, { status: 'inactive' }),
      );
      expect((await row(car.id)).removalReason).toBe('registrant_left');
      expect(await told(owner)).toEqual([]);
    });

    it('a booker who leaves: their visitor parking not yet ended is cancelled by the system', async () => {
      const { home, member } = await household();
      const booking = (
        await v.parkRaw(member, home.id, {
          areaId,
          startsAt: v.inMinutes(60),
          endsAt: v.inMinutes(120),
        })
      ).body as { id: string };
      await v.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(member.id, { status: 'inactive' }),
      );
      expect(
        await v.inTx(s.c, (tx) =>
          tx.visitorParkingBooking.findUniqueOrThrow({
            where: { id: booking.id },
          }),
        ),
      ).toMatchObject({
        status: 'cancelled',
        cancelSide: 'system',
        cancelReason: 'booker_left',
      });
    });
  });

  describe('erasure', () => {
    it('clears the reporter’s note and photo, the appellant’s words and photo, the visitors’ names and the licence photos; keeps every row', async () => {
      const { home, owner, member } = await household();
      const licence = await v.licence(member);
      const car = await v.register(member, home.id, {
        licencePhotoFileId: licence,
      });
      const reportPhoto = await v.files.ready(member.token, 'parking_photo');
      const report = (
        await v
          .http('post', '/parking-reports', member.token, {
            plate: 'ERASE 1',
            location: 'Ramp',
            note: 'My words',
            photoFileId: reportPhoto,
          })
          .expect(201)
      ).body as { id: string };
      const fine = await v.fine(s.manager, home.code);
      const appealPhoto = await v.files.ready(member.token, 'parking_photo');
      await v
        .http('post', `/vehicle-fines/${fine.id}/appeal`, member.token, {
          reason: 'My appeal',
          photoFileId: appealPhoto,
        })
        .expect(200);
      const booking = (
        await v.parkRaw(member, home.id, {
          areaId,
          visitorName: 'My visitor',
          startsAt: v.inMinutes(60),
          endsAt: v.inMinutes(120),
        })
      ).body as { id: string };
      await eraseNow(h, s.c, member.id);

      const reportRow = await v.inTx(s.c, (tx) =>
        tx.parkingReport.findUniqueOrThrow({ where: { id: report.id } }),
      );
      expect(reportRow).toMatchObject({
        reporterId: member.id,
        note: null,
        photoFileId: null,
        plate: 'ERASE 1',
        location: 'Ramp',
      });
      expect(reportRow.noteClearedAt).not.toBeNull();
      const fineRow = await v.inTx(s.c, (tx) =>
        tx.vehicleFine.findUniqueOrThrow({ where: { id: fine.id } }),
      );
      expect(fineRow).toMatchObject({
        status: 'under_appeal',
        appealText: null,
        appealPhotoFileId: null,
        appealedById: member.id,
      });
      expect(fineRow.appealClearedAt).not.toBeNull();
      expect(fineRow.appealedAt).not.toBeNull();
      expect(
        await v.inTx(s.c, (tx) =>
          tx.visitorParkingBooking.findUniqueOrThrow({
            where: { id: booking.id },
          }),
        ),
      ).toMatchObject({ visitorName: null, status: 'cancelled' });
      expect(await row(car.id)).toMatchObject({
        registeredById: member.id,
        licencePhotoFileId: null,
        status: 'removed',
      });
      for (const id of [licence, reportPhoto, appealPhoto]) {
        const file = await v.inTx(s.c, (tx) =>
          tx.storedFile.findUnique({ where: { id } }),
        );
        expect(file === null || file.deletedAt !== null).toBe(true);
      }
      // The staff decide the appeal still; its words are gone.
      const staff = (
        await v
          .http('get', `/staff/vehicle-fines/${fine.id}`, s.manager.token)
          .expect(200)
      ).body as {
        appeal: { reason: string | null };
        appealedBy: { erased?: true };
      };
      expect(staff.appeal.reason).toBeNull();
      expect(staff.appealedBy).toEqual({ id: member.id, erased: true });
      // The primary still sees the unit's fine, without the words.
      expect(
        (
          (
            await v
              .http('get', `/vehicle-fines/${fine.id}`, owner.token)
              .expect(200)
          ).body as { appeal: { reason: string | null } }
        ).appeal.reason,
      ).toBeNull();
    });

    it('the clearing is the only update an appeal takes: the database refuses a rewrite', async () => {
      const { home, owner } = await household();
      const fine = await v.fine(s.manager, home.code);
      await v
        .http('post', `/vehicle-fines/${fine.id}/appeal`, owner.token, {
          reason: 'First',
        })
        .expect(200);
      await expect(
        v.inTx(s.c, (tx) =>
          tx.vehicleFine.update({
            where: { id: fine.id },
            data: { appealText: 'Rewritten' },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        v.inTx(s.c, (tx) =>
          tx.vehicleFine.update({
            where: { id: fine.id },
            data: { appealedAt: new Date() },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('export', () => {
    async function exportOf(p: Who & { email: string }) {
      await stepUp(h, p.token, p.email);
      const asked = await v
        .http('post', '/me/data-exports', p.token, {})
        .expect(201);
      await buildExports(h);
      const dl = await v
        .http(
          'get',
          `/me/data-exports/${(asked.body as { id: string }).id}/download`,
          p.token,
        )
        .expect(200);
      return readArchive((dl.body as { url: string }).url);
    }

    it('the account’s vehicles, bookings, fines and reports; payments only where it sees the money; nobody else’s name', async () => {
      const home = await v.unit(s.c);
      const owner = await v.owner(s.c, home.id);
      const joined = await v.x.joinFamily(s.c, home.id, owner);
      const member = {
        ...(await v.who(s.c, joined.accountId, 'family')),
        email: joined.email,
      };
      const licence = await v.licence(member);
      const car = await v.register(member, home.id, {
        licencePhotoFileId: licence,
      });
      await v.register(owner, home.id);
      await v.parkRaw(member, home.id, {
        areaId,
        visitorName: 'Export visitor',
        startsAt: v.inMinutes(60),
        endsAt: v.inMinutes(120),
      });
      const fine = await v.fine(s.manager, home.code, { amount: '100' });
      await v
        .http(
          'post',
          `/staff/vehicle-fines/${fine.id}/payments`,
          s.manager.token,
          {
            amount: '100',
            receiptNumber: `EXP-${Date.now()}`,
            paidOn: day(0),
          },
        )
        .expect(201);
      await v
        .http('post', '/parking-reports', member.token, {
          plate: 'EXP 1',
          location: 'Gate',
        })
        .expect(201);
      const archive = await exportOf(member);
      expect(
        archive.names.filter((n) => n.startsWith('vehicles/')).sort(),
      ).toEqual(
        [
          'vehicles/fines.json',
          'vehicles/parking-reports.json',
          'vehicles/vehicles.json',
          'vehicles/visitor-parking-bookings.json',
        ].sort(),
      );
      const json = (name: string) =>
        JSON.parse(archive.text(name)) as Record<string, unknown>[];
      const vehicles = json('vehicles/vehicles.json');
      expect(vehicles).toHaveLength(2);
      expect(vehicles.find((x) => x.registeredByMe)).toMatchObject({
        plate: car.plate,
        unitCode: home.code,
        licencePhoto: true,
      });
      expect(json('vehicles/visitor-parking-bookings.json')).toEqual([
        expect.objectContaining({ visitorName: 'Export visitor' }),
      ]);
      // A member without finance sees the unit's fines, not its payments.
      expect(json('vehicles/fines.json')).toEqual([
        expect.objectContaining({ reference: fine.reference, payments: null }),
      ]);
      expect(json('vehicles/parking-reports.json')).toEqual([
        expect.objectContaining({ plate: 'EXP 1', status: 'open' }),
      ]);
      const name = (
        await v.inTx(s.c, (tx) =>
          tx.account.findUniqueOrThrow({ where: { id: owner.id } }),
        )
      ).fullName!;
      for (const n of archive.names.filter(
        (x) => x.startsWith('vehicles/') && x.endsWith('.json'),
      ))
        expect(archive.text(n)).not.toContain(name);
    });
  });
});
