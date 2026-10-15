import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
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
