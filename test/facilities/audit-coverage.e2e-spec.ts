import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { BOOKING_EXPIRE_SWEEP } from '../../src/facilities/bookings/staff-bookings.service';
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
} from '../setup/audit-coverage-split';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per facilities catalog entry (ADR 0014, 0044): actor,
 * target, changes and metadata — ids, codes, counts, rules and windows by
 * value; never a facility's names or descriptions, a booker's name, or a
 * payment's words.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — facilities', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) expect(JSON.stringify(row)).not.toContain(MARKER);
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

  describe('set-up', () => {
    let facilityId: string;

    beforeAll(async () => {
      const res = await f
        .http('post', '/staff/facilities', s.manager.token, {
          mode: 'bookable',
          nameEn: `${MARKER} court`,
          nameAr: `${MARKER} ملعب`,
          descriptionEn: `${MARKER} clay`,
          slotMinutes: 60,
          capacity: 2,
        })
        .expect(201);
      facilityId = (res.body as { id: string }).id;
    });

    it('facility.created — mode and rules by value, names and description only as changed', async () => {
      const row = await single('facility.created', facilityId);
      expect(row).toMatchObject(by(s.manager, 'facility'));
      expect(row.changes).toMatchObject({
        mode: { from: null, to: 'bookable' },
        capacity: { from: null, to: 2 },
        weeklyQuota: { from: null, to: 2 },
        nameEn: { changed: true },
        nameAr: { changed: true },
        descriptionEn: { changed: true },
      });
    });

    it('facility.updated — what changed, the names only as changed; nothing when nothing changed', async () => {
      await f
        .http('patch', `/staff/facilities/${facilityId}`, s.manager.token, {
          nameEn: `${MARKER} court 2`,
          capacity: 3,
          active: false,
        })
        .expect(200);
      await f
        .http('patch', `/staff/facilities/${facilityId}`, s.manager.token, {
          capacity: 3,
        })
        .expect(200);
      const row = await single('facility.updated', facilityId);
      expect(row).toMatchObject(by(s.manager, 'facility'));
      expect(row.changes).toEqual({
        nameEn: { changed: true },
        capacity: { from: 2, to: 3 },
        active: { from: true, to: false },
      });
    });

    it('facility.hours_changed and facility.peaks_changed — the windows as codes', async () => {
      await f
        .http('put', `/staff/facilities/${facilityId}/hours`, s.manager.token, {
          windows: [{ weekday: 1, startMinute: 360, endMinute: 1320 }],
        })
        .expect(200);
      await f
        .http(
          'put',
          `/staff/facilities/${facilityId}/peak-windows`,
          s.manager.token,
          { windows: [{ weekday: 1, startMinute: 1080, endMinute: 1260 }] },
        )
        .expect(200);
      const hours = await single('facility.hours_changed', facilityId);
      expect(hours).toMatchObject(by(s.manager, 'facility'));
      expect(hours.changes).toEqual({
        windows: { from: [], to: ['1:360-1320'] },
      });
      const peaks = await single('facility.peaks_changed', facilityId);
      expect(peaks.changes).toEqual({
        windows: { from: [], to: ['1:1080-1260'] },
      });
    });
  });

  describe('bookings', () => {
    let court: string;

    beforeAll(async () => {
      court = await f.facility(s.c, s.manager);
    });

    it('booking.created — the facility, unit, status, peak, guests and start; never who', async () => {
      const b = await f.book(s.alice, s.homeA.id, court, at(day(2), 10));
      const row = await single('booking.created', b.id);
      expect(row).toMatchObject(by(s.alice, 'booking'));
      expect(row.metadata).toEqual({
        facilityId: court,
        unitId: s.homeA.id,
        status: 'confirmed',
        peak: false,
        guests: 0,
        startsAt: at(day(2), 10).toISOString(),
      });
    });

    it('booking.cancelled — the side, the reason code and the status it left', async () => {
      const b = await f.book(s.bob, s.homeB.id, court, at(day(3), 10));
      await f.cancel(s.bob, b.id, 'cannot_attend').expect(204);
      const row = await single('booking.cancelled', b.id);
      expect(row).toMatchObject(by(s.bob, 'booking'));
      expect(row.metadata).toEqual({
        facilityId: court,
        unitId: s.homeB.id,
        from: 'confirmed',
        side: 'resident',
        reasonCode: 'cannot_attend',
      });
    });
  });

  describe('decisions', () => {
    let room: string;

    beforeAll(async () => {
      room = await f.facility(s.c, s.manager, {
        requiresApproval: true,
        capacity: 3,
      });
    });

    it('booking.approved — by the handler; the facility and unit', async () => {
      const b = await f.book(s.alice, s.homeA.id, room, at(day(2), 12));
      await f
        .http('post', `/staff/bookings/${b.id}/approve`, s.handler.token)
        .expect(204);
      const row = await single('booking.approved', b.id);
      expect(row).toMatchObject(by(s.handler, 'booking'));
      expect(row.metadata).toEqual({ facilityId: room, unitId: s.homeA.id });
    });

    it('booking.rejected — the reason code', async () => {
      const b = await f.book(s.bob, s.homeB.id, room, at(day(2), 12));
      await f
        .http('post', `/staff/bookings/${b.id}/reject`, s.handler.token, {
          reasonCode: 'not_eligible',
        })
        .expect(204);
      const row = await single('booking.rejected', b.id);
      expect(row).toMatchObject(by(s.handler, 'booking'));
      expect(row.metadata).toEqual({
        facilityId: room,
        unitId: s.homeB.id,
        reasonCode: 'not_eligible',
      });
    });

    it('booking.cancelled by the staff — side staff, the reason code', async () => {
      const b = await f.book(s.bob, s.homeB.id, room, at(day(3), 12));
      await f
        .http('post', `/staff/bookings/${b.id}/cancel`, s.handler.token, {
          reasonCode: 'rules_violation',
        })
        .expect(204);
      const [row] = await rows('booking.cancelled', b.id);
      expect(row).toMatchObject(by(s.handler, 'booking'));
      expect(row.metadata).toMatchObject({
        side: 'staff',
        reasonCode: 'rules_violation',
      });
    });

    it('booking.expired — by the system', async () => {
      const id = await f.rawBooking(s.c, {
        facilityId: room,
        unitId: s.homeA.id,
        bookedById: s.alice.id,
        startsAt: new Date(Date.now() - 60_000),
        status: 'pending',
      });
      await f.sweep(BOOKING_EXPIRE_SWEEP);
      const row = await single('booking.expired', id);
      expect(row).toMatchObject({ actorType: 'system', targetType: 'booking' });
      expect(row.metadata).toEqual({
        facilityId: room,
        unitId: s.homeA.id,
        reasonCode: 'approval_expired',
      });
    });
  });

  describe('closures', () => {
    it('facility_closure.created and .lifted — the window, the codes, how many it cancelled', async () => {
      const court = await f.facility(s.c, s.manager);
      const b = await f.book(s.alice, s.homeA.id, court, at(day(4), 10));
      const res = await f
        .http('post', `/staff/facilities/${court}/closures`, s.manager.token, {
          startsAt: at(day(4), 9).toISOString(),
          endsAt: at(day(4), 12).toISOString(),
          reasonCode: 'weather',
        })
        .expect(201);
      const id = (res.body as { id: string }).id;
      const created = await single('facility_closure.created', id);
      expect(created).toMatchObject(by(s.manager, 'facility_closure'));
      expect(created.metadata).toEqual({
        facilityId: court,
        reasonCode: 'weather',
        startsAt: at(day(4), 9).toISOString(),
        endsAt: at(day(4), 12).toISOString(),
        cancelledCount: 1,
      });
      const [cancelled] = await rows('booking.cancelled', b.id);
      expect(cancelled).toMatchObject({ actorId: s.manager.id });
      expect(cancelled.metadata).toMatchObject({
        side: 'system',
        reasonCode: 'facility_closed',
        closureId: id,
      });
      await f
        .http('post', `/staff/facility-closures/${id}/lift`, s.manager.token, {
          reasonCode: 'reopened_early',
        })
        .expect(204);
      const lifted = await single('facility_closure.lifted', id);
      expect(lifted).toMatchObject(by(s.manager, 'facility_closure'));
      expect(lifted.metadata).toEqual({
        facilityId: court,
        reasonCode: 'reopened_early',
      });
    });
  });

  describe('no-shows and suspensions', () => {
    it('facility.settings_changed — the rules by value', async () => {
      await f
        .http('patch', '/staff/facility-settings', s.manager.token, {
          noShowThreshold: 2,
        })
        .expect(200);
      const row = await single('facility.settings_changed', s.c.tenantId);
      expect(row).toMatchObject(by(s.manager, 'tenant'));
      expect(row.changes).toEqual({ noShowThreshold: { from: 3, to: 2 } });
    });

    it('booking.no_show, booking_suspension.started and .lifted — ids, counts, codes', async () => {
      const court = await f.facility(s.c, s.manager);
      const ended = () =>
        f.rawBooking(s.c, {
          facilityId: court,
          unitId: s.homeB.id,
          bookedById: s.bob.id,
          startsAt: new Date(Date.now() - 2 * 3_600_000),
        });
      const first = await ended();
      await f
        .http('post', `/staff/bookings/${first}/no-show`, s.handler.token)
        .expect(204);
      const marked = await single('booking.no_show', first);
      expect(marked).toMatchObject(by(s.handler, 'booking'));
      expect(marked.metadata).toEqual({
        facilityId: court,
        unitId: s.homeB.id,
      });

      const second = await ended();
      await f
        .http('post', `/staff/bookings/${second}/no-show`, s.handler.token)
        .expect(204);
      const suspension = await f.inTx(s.c, (tx) =>
        tx.bookingSuspension.findFirstOrThrow({
          where: { unitId: s.homeB.id },
        }),
      );
      const started = await single('booking_suspension.started', suspension.id);
      expect(started).toMatchObject(by(s.handler, 'booking_suspension'));
      expect(started.metadata).toEqual({
        unitId: s.homeB.id,
        triggerBookingId: second,
        noShowCount: 2,
        endsAt: suspension.endsAt.toISOString(),
      });

      await f
        .http(
          'post',
          `/staff/booking-suspensions/${suspension.id}/lift`,
          s.handler.token,
          {
            reasonCode: 'staff_error',
          },
        )
        .expect(204);
      const lifted = await single('booking_suspension.lifted', suspension.id);
      expect(lifted).toMatchObject(by(s.handler, 'booking_suspension'));
      expect(lifted.metadata).toEqual({
        unitId: s.homeB.id,
        reasonCode: 'staff_error',
      });
    });
  });

  describe('catalog completeness', () => {
    it('every facilities entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of FACILITIES_COVERAGE) {
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
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...FACILITIES_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter((k) => /^(facility|facilities|booking|club)[._]/.test(k))
          .sort(),
      ).toEqual([...FACILITIES_COVERAGE].sort());
    });
  });
});
