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
} from '../setup/audit-coverage-split';
import {
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
