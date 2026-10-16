import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { gateHelpers } from '../setup/gate';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FACILITIES_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  NEIGHBOURS_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { day, sticker, vehicleHelpers, type Who } from '../setup/vehicles';

/**
 * One scenario per vehicles and parking catalog entry (ADR 0014, 0045):
 * actor, target, changes and metadata — ids, codes, statuses, days and
 * amounts by value; a plate only as changed, never a name, a visitor's
 * name, a note or an appeal's words.
 */
const covered = new Set<string>();

/** A plate typed in every scenario: no audit row may hold it. */
const PLATE = 'AUD 9871';
const PLATE_KEY = 'AUD9871';

describe('Audit coverage — vehicles and parking', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    read = auditReaders(h);
    await v
      .http('patch', '/staff/vehicle-settings', s.manager.token, {
        maxVehiclesPerUnit: 20,
      })
      .expect(200);
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) {
      const text = JSON.stringify(row);
      expect(text).not.toContain(PLATE);
      expect(text).not.toContain(PLATE_KEY);
    }
    return found;
  }
  async function single(action: string, targetId: string) {
    const found = await rows(action, targetId);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });

  describe('vehicles', () => {
    let carId: string;

    beforeAll(async () => {
      carId = (
        await v.register(s.alice, s.home.id, {
          plate: PLATE,
          licencePhotoFileId: await v.licence(s.alice),
        })
      ).id;
    });

    it('vehicle.registered — the unit, number and type; the plate never', async () => {
      const row = await single('vehicle.registered', carId);
      expect(row).toMatchObject(by(s.alice, 'vehicle'));
      expect(row.metadata).toEqual({
        unitId: s.home.id,
        number: expect.any(Number) as number,
        type: 'car',
        licencePhoto: true,
      });
    });

    it('vehicle.updated — colour by value; the same plate typed differently only as changed', async () => {
      await v
        .http('patch', `/vehicles/${carId}`, s.alice.token, {
          color: 'Black',
          plate: 'aud  9871',
        })
        .expect(200);
      const row = await single('vehicle.updated', carId);
      expect(row).toMatchObject(by(s.alice, 'vehicle'));
      expect(row.changes).toEqual({ color: { from: 'Silver', to: 'Black' } });
      expect(row.metadata).toEqual({ unitId: s.home.id });
    });

    it('vehicle.approved — the sticker, the last day and the version read', async () => {
      const number = sticker();
      await v
        .approveRaw(s.manager, carId, {
          stickerNumber: number,
          permitValidUntil: day(300),
        })
        .then((r) => expect(r.status).toBe(200));
      const row = await single('vehicle.approved', carId);
      expect(row).toMatchObject(by(s.manager, 'vehicle'));
      expect(row.metadata).toEqual({
        unitId: s.home.id,
        stickerNumber: number,
        permitValidUntil: day(300),
        version: 1,
      });
    });

    it('vehicle.renewed — from and to', async () => {
      await v
        .http('post', `/staff/vehicles/${carId}/renew`, s.manager.token, {
          permitValidUntil: day(400),
        })
        .expect(200);
      const row = await single('vehicle.renewed', carId);
      expect(row).toMatchObject(by(s.manager, 'vehicle'));
      expect(row.metadata).toEqual({
        unitId: s.home.id,
        from: day(300),
        to: day(400),
      });
    });

    it('vehicle.plate_changed — the plate only as changed, the status it left and the new version', async () => {
      await v
        .http('patch', `/vehicles/${carId}`, s.alice.token, {
          plate: 'AUD 9872',
        })
        .expect(200);
      const row = await single('vehicle.plate_changed', carId);
      expect(row).toMatchObject(by(s.alice, 'vehicle'));
      expect(row.changes).toEqual({ plate: { changed: true } });
      expect(row.metadata).toEqual({
        unitId: s.home.id,
        previousStatus: 'active',
        version: 2,
      });
    });

    it('vehicle.rejected — the reason code and the version read', async () => {
      await v
        .http('post', `/staff/vehicles/${carId}/reject`, s.manager.token, {
          version: 2,
          reasonCode: 'plate_mismatch',
        })
        .expect(200);
      const row = await single('vehicle.rejected', carId);
      expect(row).toMatchObject(by(s.manager, 'vehicle'));
      expect(row.metadata).toEqual({
        unitId: s.home.id,
        reasonCode: 'plate_mismatch',
        version: 2,
      });
    });

    it('vehicle.removed — the side, the reason code and the status it left', async () => {
      await v
        .http('delete', `/vehicles/${carId}?reasonCode=sold`, s.alice.token)
        .expect(204);
      const row = await single('vehicle.removed', carId);
      expect(row).toMatchObject(by(s.alice, 'vehicle'));
      expect(row.metadata).toEqual({
        unitId: s.home.id,
        side: 'resident',
        reasonCode: 'sold',
        previousStatus: 'rejected',
      });
    });

    it('vehicle.settings_changed — the numbers by value', async () => {
      await v
        .http('patch', '/staff/vehicle-settings', s.manager.token, {
          maxVehiclesPerUnit: 19,
          visitorParkingMaxHours: 6,
        })
        .expect(200);
      const found = await rows('vehicle.settings_changed', s.c.tenantId);
      const row = found[found.length - 1];
      expect(row).toMatchObject(by(s.manager, 'tenant'));
      expect(row.changes).toEqual({
        maxVehiclesPerUnit: { from: 20, to: 19 },
        visitorParkingMaxHours: { from: 12, to: 6 },
      });
    });
  });

  describe('parking', () => {
    const NAME = 'AUDIT-VISITOR-NAME';
    let slotId: string;
    let areaId: string;
    let bookingId: string;

    beforeAll(async () => {
      slotId = (
        (
          await v
            .http('post', '/staff/parking-slots', s.manager.token, {
              unitCode: s.home.code,
              code: 'AUD-1',
              place: 'Basement 1',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      areaId = (
        (
          await v
            .http('post', '/staff/visitor-parking-areas', s.manager.token, {
              name: 'AUDIT-AREA-NAME',
              capacity: 4,
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      bookingId = (
        (
          await v
            .parkRaw(s.alice, s.home.id, {
              areaId,
              visitorName: NAME,
              startsAt: v.inMinutes(60),
              endsAt: v.inMinutes(120),
            })
            .then((r) => {
              expect(r.status).toBe(201);
              return r;
            })
        ).body as { id: string }
      ).id;
    });

    it('parking_slot.created / updated / deleted — the unit, code and place', async () => {
      await v
        .http('patch', `/staff/parking-slots/${slotId}`, s.manager.token, {
          place: 'Basement 2',
        })
        .expect(200);
      await v
        .http('delete', `/staff/parking-slots/${slotId}`, s.manager.token)
        .expect(204);
      expect(await single('parking_slot.created', slotId)).toMatchObject({
        ...by(s.manager, 'parking_slot'),
        metadata: { unitId: s.home.id, code: 'AUD-1', place: 'Basement 1' },
      });
      expect(await single('parking_slot.updated', slotId)).toMatchObject({
        changes: { place: { from: 'Basement 1', to: 'Basement 2' } },
        metadata: { unitId: s.home.id },
      });
      expect(await single('parking_slot.deleted', slotId)).toMatchObject({
        metadata: { unitId: s.home.id, code: 'AUD-1' },
      });
    });

    it('visitor_parking_area.created / updated — capacity and active by value, the name only as changed', async () => {
      await v
        .http(
          'patch',
          `/staff/visitor-parking-areas/${areaId}`,
          s.manager.token,
          {
            name: 'AUDIT-AREA-NAME 2',
            capacity: 5,
          },
        )
        .expect(200);
      const created = await single('visitor_parking_area.created', areaId);
      expect(created).toMatchObject(by(s.manager, 'visitor_parking_area'));
      expect(created.changes).toEqual({
        name: { changed: true },
        capacity: { from: null, to: 4 },
        active: { from: null, to: true },
      });
      const updated = await single('visitor_parking_area.updated', areaId);
      expect(updated.changes).toEqual({
        name: { changed: true },
        capacity: { from: 4, to: 5 },
      });
      expect(JSON.stringify([created, updated])).not.toContain('AUDIT-AREA');
    });

    it('visitor_parking_booking.created / cancelled — the unit, area and window; never the visitor’s name', async () => {
      await v
        .http(
          'delete',
          `/units/${s.home.id}/visitor-parking-bookings/${bookingId}`,
          s.alice.token,
        )
        .expect(204);
      const created = await single(
        'visitor_parking_booking.created',
        bookingId,
      );
      expect(created).toMatchObject(by(s.alice, 'visitor_parking_booking'));
      expect(created.metadata).toEqual({
        unitId: s.home.id,
        areaId,
        visitorPassId: null,
        number: expect.any(Number) as number,
        startsAt: expect.any(String) as string,
        endsAt: expect.any(String) as string,
      });
      const cancelled = await single(
        'visitor_parking_booking.cancelled',
        bookingId,
      );
      expect(cancelled.metadata).toEqual({
        unitId: s.home.id,
        areaId,
        side: 'resident',
        reasonCode: 'no_longer_needed',
      });
      expect(JSON.stringify([created, cancelled])).not.toContain(NAME);
    });
  });

  describe('the gate', () => {
    it('gate.plate_lookup — on the guard’s shift: the ids found and their count, never the plate', async () => {
      const duty = await gateHelpers(h).onDuty(s.c);
      const guard = await v.who(s.c, duty.guardId, 'staff');
      await v
        .http('post', '/gate/plate-lookup', guard.token, { plate: PLATE })
        .expect(200);
      const row = await single('gate.plate_lookup', duty.shiftId);
      expect(row).toMatchObject(by(guard, 'guard_shift'));
      expect(row.metadata).toEqual({
        vehicleIds: [],
        passIds: [],
        permitIds: [],
        guestIds: [],
        matches: 0,
      });
    });
  });

  describe('fines', () => {
    const WORDS = 'AUDIT-APPEAL-WORDS';
    const NOTE = 'AUDIT-FINE-NOTE';
    let issuedId: string;
    let cancelledId: string;

    beforeAll(async () => {
      issuedId = (
        await v.fine(s.manager, s.home.code, {
          plate: PLATE,
          note: NOTE,
          reason: 'no_permit',
          amount: '250',
        })
      ).id;
      cancelledId = (await v.fine(s.manager, s.home.code, { plate: PLATE })).id;
    });

    it('vehicle_fine.issued — unit, reason, amount and day; never the plate or the note', async () => {
      const row = await single('vehicle_fine.issued', issuedId);
      expect(row).toMatchObject(by(s.manager, 'vehicle_fine'));
      expect(row.metadata).toEqual({
        unitId: s.home.id,
        vehicleId: null,
        number: expect.any(Number) as number,
        reason: 'no_permit',
        amount: '250.00',
        currency: 'EGP',
        occurredOn: day(0),
        photo: false,
      });
      expect(JSON.stringify(row)).not.toContain(NOTE);
    });

    it('vehicle_fine.appealed / appeal_decided — never the appeal’s words', async () => {
      await v
        .http('post', `/vehicle-fines/${issuedId}/appeal`, s.alice.token, {
          reason: WORDS,
        })
        .expect(200);
      await v
        .http(
          'post',
          `/staff/vehicle-fines/${issuedId}/decide-appeal`,
          s.manager.token,
          {
            decision: 'upheld',
          },
        )
        .expect(200);
      const appealed = await single('vehicle_fine.appealed', issuedId);
      expect(appealed).toMatchObject(by(s.alice, 'vehicle_fine'));
      expect(appealed.metadata).toEqual({ unitId: s.home.id, photo: false });
      const decided = await single('vehicle_fine.appeal_decided', issuedId);
      expect(decided).toMatchObject(by(s.manager, 'vehicle_fine'));
      expect(decided.metadata).toEqual({
        unitId: s.home.id,
        decision: 'upheld',
        reasonCode: null,
      });
      expect(JSON.stringify([appealed, decided])).not.toContain(WORDS);
    });

    it('vehicle_fine.cancelled — the reason code', async () => {
      await v
        .http(
          'post',
          `/staff/vehicle-fines/${cancelledId}/cancel`,
          s.manager.token,
          {
            reasonCode: 'issued_in_error',
          },
        )
        .expect(200);
      const row = await single('vehicle_fine.cancelled', cancelledId);
      expect(row).toMatchObject(by(s.manager, 'vehicle_fine'));
      expect(row.metadata).toEqual({
        unitId: s.home.id,
        reasonCode: 'issued_in_error',
      });
    });
  });

  describe('fine payments', () => {
    it('vehicle_fine.payment_recorded / payment_reversed — the amount, receipt and day; the reason code', async () => {
      const fine = await v.fine(s.manager, s.home.code, {
        plate: PLATE,
        amount: '120',
      });
      const receipt = `AUD-${Date.now()}`;
      const paid = (
        await v
          .http(
            'post',
            `/staff/vehicle-fines/${fine.id}/payments`,
            s.manager.token,
            {
              amount: '120',
              receiptNumber: receipt,
              paidOn: day(0),
            },
          )
          .expect(201)
      ).body as { id: string };
      const reversed = (
        await v
          .http(
            'post',
            `/staff/vehicle-fine-payments/${paid.id}/reverse`,
            s.manager.token,
            { reasonCode: 'refunded' },
          )
          .expect(201)
      ).body as { id: string };
      const recorded = await single('vehicle_fine.payment_recorded', paid.id);
      expect(recorded).toMatchObject(by(s.manager, 'vehicle_fine_payment'));
      expect(recorded.metadata).toEqual({
        fineId: fine.id,
        unitId: s.home.id,
        amount: '120.00',
        currency: 'EGP',
        receiptNumber: receipt,
        paidOn: day(0),
      });
      const reversal = await single(
        'vehicle_fine.payment_reversed',
        reversed.id,
      );
      expect(reversal.metadata).toEqual({
        fineId: fine.id,
        unitId: s.home.id,
        reversesId: paid.id,
        reasonCode: 'refunded',
      });
    });
  });

  describe('parking reports', () => {
    const PLACE = 'AUDIT-REPORT-PLACE';
    const NOTE = 'AUDIT-REPORT-NOTE';

    it('parking_report.created / closed / converted — numbers, codes and the fine; never the plate, the place or the note', async () => {
      const file = (body: object) =>
        v
          .http('post', '/parking-reports', s.alice.token, body)
          .expect(201)
          .then((r) => (r.body as { id: string }).id);
      const closedId = await file({
        plate: PLATE,
        location: PLACE,
        note: NOTE,
      });
      const convertedId = await file({ plate: PLATE, location: PLACE });
      await v
        .http(
          'post',
          `/staff/parking-reports/${closedId}/close`,
          s.manager.token,
          {
            reasonCode: 'duplicate',
          },
        )
        .expect(200);
      const converted = (
        await v
          .http(
            'post',
            `/staff/parking-reports/${convertedId}/convert`,
            s.manager.token,
            {
              unitCode: s.home.code,
              plate: PLATE,
              reason: 'blocking',
              amount: '50',
              occurredOn: day(0),
            },
          )
          .expect(200)
      ).body as { fineId: string };
      const created = await single('parking_report.created', closedId);
      expect(created).toMatchObject(by(s.alice, 'parking_report'));
      expect(created.metadata).toEqual({
        number: expect.any(Number) as number,
        note: true,
        photo: false,
      });
      await single('parking_report.created', convertedId);
      expect(
        (await single('parking_report.closed', closedId)).metadata,
      ).toEqual({ reasonCode: 'duplicate' });
      const conv = await single('parking_report.converted', convertedId);
      expect(conv).toMatchObject(by(s.manager, 'parking_report'));
      expect(conv.metadata).toEqual({ fineId: converted.fineId });
      const all = await read.tenant(s.c.tenantId, {});
      const text = JSON.stringify(all);
      expect(text).not.toContain(PLACE);
      expect(text).not.toContain(NOTE);
    });
  });

  describe('catalog completeness', () => {
    it('every vehicles and parking entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of VEHICLES_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
          ...R1_COVERAGE,
          ...RESIDENT_SCREENS_COVERAGE,
          ...MANAGEMENT_COVERAGE,
          ...ENGAGEMENT_COVERAGE,
          ...NEIGHBOURS_COVERAGE,
          ...FACILITIES_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...VEHICLES_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter(
            (k) =>
              /^(vehicle|vehicles|parking|parking_slot|visitor_parking|vehicle_fine|parking_report)[._]/.test(
                k,
              ) || k === 'gate.plate_lookup',
          )
          .sort(),
      ).toEqual([...VEHICLES_COVERAGE].sort());
    });
  });
});
