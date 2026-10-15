import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { day, rewindFine, vehicleHelpers, type Who } from '../setup/vehicles';

interface ResidentFine {
  id: string;
  reference: string;
  reason: string;
  date: string;
  plate: string;
  amount: string;
  currency: string;
  status: string;
  note: string | null;
  photoUrl: string | null;
  appeal: {
    reason: string | null;
    photoUrl: string | null;
    decision: string | null;
  } | null;
  cancelReason: string | null;
  canAppeal: boolean;
}

/**
 * ADR 0045: the staff fine a unit; its vehicle keepers and money's see the
 * fine; a keeper or the primary appeals it once, within 30 days; the staff
 * uphold or cancel. A fine says nothing of where it came from.
 */
describe('Fines', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;
  let issuer: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    await v
      .http('patch', '/staff/vehicle-settings', s.manager.token, {
        maxVehiclesPerUnit: 20,
      })
      .expect(200);
    issuer = await v.staff(s.c, ['fines.issue']);
  }, 120_000);

  afterAll(() => h.close());

  const outcome = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });

  async function household() {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const member = await v.family(s.c, home.id, owner);
    return { home, owner, member };
  }

  const listFor = async (who: Who, unitId: string, status?: string) =>
    (
      (
        await v
          .http(
            'get',
            `/units/${unitId}/vehicle-fines${status ? `?status=${status}` : ''}`,
            who.token,
          )
          .expect(200)
      ).body as { data: ResidentFine[] }
    ).data;

  describe('issuing', () => {
    it('to a unit, with its vehicle’s plate or a typed one; numbered F-; the keepers and the primary told', async () => {
      const { home, owner, member } = await household();
      const car = await v.register(member, home.id, { plate: 'FIN 1001' });
      const photo = await v.files.ready(issuer.token, 'vehicle_fine_photo');
      const res = await v.fineRaw(issuer, home.code, {
        vehicleId: car.id,
        plate: undefined,
        reason: 'parked_in_visitor_slot',
        note: '  Left in visitor area B  ',
        amount: '750.5',
        photoFileId: photo,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        unitCode: home.code,
        vehicleId: car.id,
        plate: 'FIN 1001',
        reason: 'parked_in_visitor_slot',
        note: 'Left in visitor area B',
        amount: '750.50',
        currency: 'EGP',
        occurredOn: day(0),
        status: 'unpaid',
        issuedBy: { id: issuer.id },
        photoUrl: expect.stringContaining('http') as string,
        payments: [],
      });
      const id = (res.body as { id: string; reference: string }).id;
      expect((res.body as { reference: string }).reference).toMatch(
        /^F-\d{4,}$/,
      );
      for (const who of [owner, member]) {
        const told = await v.notifications(s.c, who.id, 'vehicle_fine.issued');
        expect(told.filter((n) => n.targetId === id)).toHaveLength(1);
        expect(told.find((n) => n.targetId === id)?.params).toEqual({
          reason: 'parked_in_visitor_slot',
        });
      }
      expect(
        await v.notifications(s.c, issuer.id, 'vehicle_fine.issued'),
      ).toHaveLength(0);
      const typed = await v.fine(issuer, home.code, { plate: ' zz  9 ' });
      expect(
        (
          await v
            .http('get', `/staff/vehicle-fines/${typed.id}`, issuer.token)
            .expect(200)
        ).body,
      ).toMatchObject({ plate: 'ZZ 9', vehicleId: null });
    });

    it('refuses an unknown unit, another unit’s vehicle, no plate, a day out of range and an unknown reason', async () => {
      const a = await household();
      const b = await household();
      const theirs = await v.register(b.owner, b.home.id);
      const fields = async (
        over: Record<string, unknown>,
        unitCode = a.home.code,
      ) =>
        (
          (await v.fineRaw(issuer, unitCode, over)).body as {
            fields: unknown[];
          }
        ).fields;
      expect(await fields({}, 'NO-SUCH-UNIT')).toEqual([
        { field: 'unitCode', code: 'UNIT_CODE_UNKNOWN' },
      ]);
      expect(await fields({ vehicleId: theirs.id, plate: undefined })).toEqual([
        { field: 'vehicleId', code: 'VEHICLE_NOT_OF_UNIT' },
      ]);
      expect(await fields({ plate: undefined })).toEqual([
        { field: 'plate', code: 'FIELD_REQUIRED' },
      ]);
      expect(await fields({ occurredOn: day(1) })).toEqual([
        {
          field: 'occurredOn',
          code: 'DAY_OUT_OF_RANGE',
          params: { min: day(-90), max: day(0) },
        },
      ]);
      expect(await fields({ reason: 'speeding' })).toEqual([
        {
          field: 'reason',
          code: 'INVALID_REASON_CODE',
          params: {
            allowed: [
              'parked_in_visitor_slot',
              'parked_in_others_slot',
              'blocking',
              'no_permit',
              'fire_lane',
              'other',
            ],
          },
        },
      ]);
    });
  });

  describe('the unit’s people', () => {
    it('its vehicle keepers and whoever sees its money see it, with exactly these fields; another unit does not', async () => {
      const { home, owner, member } = await household();
      const landlordUnit = await v.unit(s.c);
      const landlord = await v.landlord(s.c, landlordUnit.id);
      const tenant = await v.tenant(s.c, landlordUnit.id);
      const issued = await v.fine(issuer, home.code);
      const rented = await v.fine(issuer, landlordUnit.code);
      for (const who of [owner, member])
        expect((await listFor(who, home.id)).map((f) => f.id)).toEqual([
          issued.id,
        ]);
      // The landlord sees the unit's money; the tenant keeps its vehicles.
      for (const who of [landlord, tenant])
        expect((await listFor(who, landlordUnit.id)).map((f) => f.id)).toEqual([
          rented.id,
        ]);
      const [one] = await listFor(owner, home.id);
      expect(Object.keys(one).sort()).toEqual(
        [
          'id',
          'reference',
          'reason',
          'date',
          'plate',
          'amount',
          'currency',
          'status',
          'note',
          'photoUrl',
          'appeal',
          'cancelReason',
          'canAppeal',
          'createdAt',
        ].sort(),
      );
      expect(one).toMatchObject({ canAppeal: true, appeal: null });
      expect(
        outcome(
          await v.http(
            'get',
            `/units/${home.id}/vehicle-fines`,
            landlord.token,
          ),
        ),
      ).toEqual({ status: 404, code: 'UNIT_NOT_FOUND' });
      expect(
        outcome(
          await v.http('get', `/vehicle-fines/${issued.id}`, landlord.token),
        ),
      ).toEqual({ status: 404, code: 'VEHICLE_FINE_NOT_FOUND' });
    });

    it('filters: unpaid includes under appeal; paid; cancelled', async () => {
      const { home, owner } = await household();
      const unpaid = await v.fine(issuer, home.code);
      const appealed = await v.fine(issuer, home.code);
      const cancelled = await v.fine(issuer, home.code);
      await v
        .http('post', `/vehicle-fines/${appealed.id}/appeal`, owner.token, {
          reason: 'Not our car',
        })
        .expect(200);
      await v
        .http(
          'post',
          `/staff/vehicle-fines/${cancelled.id}/cancel`,
          issuer.token,
          {
            reasonCode: 'duplicate',
          },
        )
        .expect(200);
      const ids = async (status: string) =>
        (await listFor(owner, home.id, status)).map((f) => f.id).sort();
      expect(await ids('unpaid')).toEqual([unpaid.id, appealed.id].sort());
      expect(await ids('cancelled')).toEqual([cancelled.id]);
      expect(await ids('paid')).toEqual([]);
    });
  });

  describe('the appeal', () => {
    it('once, by a vehicle keeper or the primary, with words and a photo; a landlord may not', async () => {
      const { home, owner, member } = await household();
      const issued = await v.fine(issuer, home.code);
      const photo = await v.files.ready(member.token, 'parking_photo');
      const res = await v
        .http('post', `/vehicle-fines/${issued.id}/appeal`, member.token, {
          reason: '  The car was a visitor’s with a pass.  ',
          photoFileId: photo,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'under_appeal',
        canAppeal: false,
        appeal: {
          reason: 'The car was a visitor’s with a pass.',
          photoUrl: expect.stringContaining('http') as string,
          decision: null,
        },
      });
      expect(
        outcome(
          await v.http(
            'post',
            `/vehicle-fines/${issued.id}/appeal`,
            owner.token,
            {
              reason: 'Again',
            },
          ),
        ),
      ).toEqual({ status: 409, code: 'FINE_APPEAL_CLOSED' });
      const rentedUnit = await v.unit(s.c);
      const landlord = await v.landlord(s.c, rentedUnit.id);
      const theirs = await v.fine(issuer, rentedUnit.code);
      expect(
        outcome(
          await v.http(
            'post',
            `/vehicle-fines/${theirs.id}/appeal`,
            landlord.token,
            {
              reason: 'Not mine',
            },
          ),
        ),
      ).toEqual({ status: 403, code: 'FINE_APPEAL_NOT_ALLOWED' });
    });

    it('within 30 days of the fine', async () => {
      const { home, owner } = await household();
      const issued = await v.fine(issuer, home.code);
      await rewindFine(issued.id, 31);
      expect(
        (
          await v.http(
            'post',
            `/vehicle-fines/${issued.id}/appeal`,
            owner.token,
            {
              reason: 'Late',
            },
          )
        ).body,
      ).toMatchObject({
        code: 'FINE_APPEAL_WINDOW_PASSED',
        params: { days: 30 },
      });
      expect(
        (
          (
            await v
              .http('get', `/vehicle-fines/${issued.id}`, owner.token)
              .expect(200)
          ).body as ResidentFine
        ).canAppeal,
      ).toBe(false);
    });

    it('upheld: unpaid again, the appellant told; cancelled: with its reason, told too', async () => {
      const { home, owner, member } = await household();
      const one = await v.fine(issuer, home.code);
      const two = await v.fine(issuer, home.code);
      for (const f of [one, two])
        await v
          .http('post', `/vehicle-fines/${f.id}/appeal`, member.token, {
            reason: 'Please review',
          })
          .expect(200);
      expect(
        (
          await v.http(
            'post',
            `/staff/vehicle-fines/${one.id}/decide-appeal`,
            issuer.token,
            { decision: 'upheld', reasonCode: 'other' },
          )
        ).body,
      ).toMatchObject({
        fields: [{ field: 'reasonCode', code: 'FIELD_NOT_ALLOWED' }],
      });
      await v
        .http(
          'post',
          `/staff/vehicle-fines/${one.id}/decide-appeal`,
          issuer.token,
          {
            decision: 'upheld',
          },
        )
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({
            status: 'unpaid',
            appeal: { decision: 'upheld' },
            decidedBy: { id: issuer.id },
          }),
        );
      await v
        .http(
          'post',
          `/staff/vehicle-fines/${two.id}/decide-appeal`,
          issuer.token,
          {
            decision: 'cancelled',
          },
        )
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({
            status: 'cancelled',
            cancelReason: 'appeal_accepted',
            appeal: { decision: 'cancelled' },
          }),
        );
      expect(
        outcome(
          await v.http(
            'post',
            `/staff/vehicle-fines/${one.id}/decide-appeal`,
            issuer.token,
            { decision: 'cancelled' },
          ),
        ),
      ).toEqual({ status: 409, code: 'FINE_NOT_UNDER_APPEAL' });
      expect(
        (
          await v.notifications(s.c, member.id, 'vehicle_fine.appeal_upheld')
        ).map((n) => n.targetId),
      ).toEqual([one.id]);
      expect(
        (
          await v.notifications(s.c, member.id, 'vehicle_fine.appeal_accepted')
        ).map((n) => n.targetId),
      ).toEqual([two.id]);
      expect(
        await v.notifications(s.c, owner.id, 'vehicle_fine.appeal_upheld'),
      ).toHaveLength(0);
    });

    it('a fine under appeal is not cancelled outside the decision', async () => {
      const { home, owner } = await household();
      const issued = await v.fine(issuer, home.code);
      await v
        .http('post', `/vehicle-fines/${issued.id}/appeal`, owner.token, {
          reason: 'Review',
        })
        .expect(200);
      expect(
        outcome(
          await v.http(
            'post',
            `/staff/vehicle-fines/${issued.id}/cancel`,
            issuer.token,
            {
              reasonCode: 'other',
            },
          ),
        ),
      ).toEqual({ status: 409, code: 'FINE_NOT_CANCELLABLE' });
    });
  });

  describe('the staff', () => {
    it('the appeals queue, oldest first; the accountant reads fines but issues none', async () => {
      const { home, owner } = await household();
      const first = await v.fine(issuer, home.code);
      const second = await v.fine(issuer, home.code);
      for (const f of [first, second])
        await v
          .http('post', `/vehicle-fines/${f.id}/appeal`, owner.token, {
            reason: 'Review',
          })
          .expect(200);
      const queue = (
        await v
          .http(
            'get',
            `/staff/vehicle-fines?status=under_appeal&unitCode=${encodeURIComponent(home.code)}`,
            issuer.token,
          )
          .expect(200)
      ).body as { data: { id: string }[] };
      expect(queue.data.map((f) => f.id)).toEqual([first.id, second.id]);
      const accountant = await v.staff(s.c, ['fines.billing']);
      await v
        .http('get', `/staff/vehicle-fines/${first.id}`, accountant.token)
        .expect(200);
      expect(outcome(await v.fineRaw(accountant, home.code))).toEqual({
        status: 403,
        code: 'FORBIDDEN',
      });
    });
  });
});
