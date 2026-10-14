import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  ALL_WEEK,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

interface FacilityBody {
  id: string;
  mode: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  active: boolean;
  hours: { weekday: number; startMinute: number; endMinute: number }[];
  peakWindows: { weekday: number; startMinute: number; endMinute: number }[];
  rules: Record<string, unknown> | null;
}

const w = (weekday: number, startMinute: number, endMinute: number) => ({
  weekday,
  startMinute,
  endMinute,
});

describe('Facilities: set-up (ADR 0044)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
  }, 180_000);

  afterAll(() => h.close());

  const create = (body: object, as: Who = s.manager) =>
    f.http('post', '/staff/facilities', as.token, body);
  const staffGet = async (id: string) =>
    (
      await f
        .http('get', `/staff/facilities/${id}`, s.manager.token)
        .expect(200)
    ).body as FacilityBody;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;

  describe('creating', () => {
    it('a bookable facility names its slot and capacity; the other rules take their defaults; it starts with no hours', async () => {
      const res = await create({
        mode: 'bookable',
        nameEn: '  Tennis court  ',
        nameAr: 'ملعب تنس',
        descriptionEn: 'Clay',
        slotMinutes: 60,
        capacity: 1,
      }).expect(201);
      const body = res.body as FacilityBody;
      expect(body).toMatchObject({
        mode: 'bookable',
        nameEn: 'Tennis court',
        descriptionEn: 'Clay',
        descriptionAr: null,
        active: true,
        hours: [],
        peakWindows: [],
        rules: {
          slotMinutes: 60,
          capacity: 1,
          capacityUnit: 'bookings',
          maxDaysAhead: 14,
          minMinutesBefore: 60,
          cancelCutoffMinutes: 120,
          maxGuests: 0,
          requiresApproval: false,
          requiresMembership: false,
          weeklyQuota: 2,
          peakQuota: 1,
        },
      });
    });

    it('a walk-in facility takes no rule, and a bookable one needs its slot and capacity', async () => {
      const walkIn = await create({
        mode: 'walk_in',
        nameEn: 'Pool',
        nameAr: 'حمام السباحة',
      }).expect(201);
      expect((walkIn.body as FacilityBody).rules).toBeNull();

      const refused = await create({
        mode: 'walk_in',
        nameEn: 'Gym',
        nameAr: 'صالة',
        capacity: 10,
        requiresApproval: true,
      }).expect(400);
      expect(fields(refused)).toEqual([
        { field: 'capacity', code: 'FIELD_NOT_ALLOWED' },
        { field: 'requiresApproval', code: 'FIELD_NOT_ALLOWED' },
      ]);
      const missing = await create({
        mode: 'bookable',
        nameEn: 'Hall',
        nameAr: 'قاعة',
      }).expect(400);
      expect(fields(missing)).toEqual([
        { field: 'slotMinutes', code: 'FIELD_REQUIRED' },
        { field: 'capacity', code: 'FIELD_REQUIRED' },
      ]);
    });

    it('a blank name is missing; a peak quota above the weekly one is refused', async () => {
      const res = await create({
        mode: 'bookable',
        nameEn: '   ',
        nameAr: 'قاعة',
        slotMinutes: 60,
        capacity: 1,
        weeklyQuota: 2,
        peakQuota: 3,
      }).expect(400);
      expect(fields(res)).toEqual([
        { field: 'nameEn', code: 'FIELD_REQUIRED' },
        {
          field: 'peakQuota',
          code: 'PEAK_QUOTA_ABOVE_WEEKLY',
          params: { max: 2 },
        },
      ]);
    });

    it('the same Idempotency-Key creates one facility and answers the same', async () => {
      const body = {
        mode: 'bookable',
        nameEn: 'BBQ',
        nameAr: 'شواء',
        slotMinutes: 120,
        capacity: 3,
      };
      const headers = { 'Idempotency-Key': `facility-${s.c.tenantId}` };
      const [one, two] = await Promise.all([
        f.http('post', '/staff/facilities', s.manager.token, body, headers),
        f.http('post', '/staff/facilities', s.manager.token, body, headers),
      ]);
      expect([one.status, two.status]).toEqual([201, 201]);
      expect(one.body).toEqual(two.body);
      const rows = await f.inTx(s.c, (tx) =>
        tx.facility.count({ where: { nameEn: 'BBQ' } }),
      );
      expect(rows).toBe(1);
    });
  });

  describe('updating', () => {
    it('names, order, state and rules change; the peak quota is checked against the weekly one as it will be', async () => {
      const id = await f.facility(s.c, s.manager);
      const res = await f
        .http('patch', `/staff/facilities/${id}`, s.manager.token, {
          nameAr: ' ملعب ١ ',
          position: 3,
          capacity: 4,
          capacityUnit: 'people',
          weeklyQuota: 3,
          peakQuota: 3,
          descriptionEn: 'Lit at night',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        nameAr: 'ملعب ١',
        position: 3,
        descriptionEn: 'Lit at night',
        rules: {
          capacity: 4,
          capacityUnit: 'people',
          weeklyQuota: 3,
          peakQuota: 3,
        },
      });
      const lower = await f
        .http('patch', `/staff/facilities/${id}`, s.manager.token, {
          weeklyQuota: 2,
        })
        .expect(400);
      expect(fields(lower)).toEqual([
        {
          field: 'peakQuota',
          code: 'PEAK_QUOTA_ABOVE_WEEKLY',
          params: { max: 2 },
        },
      ]);
      await f
        .http('patch', `/staff/facilities/${id}`, s.manager.token, {
          descriptionEn: null,
        })
        .expect(200);
      expect((await staffGet(id)).descriptionEn).toBeNull();
    });

    it('a walk-in facility takes no rule, and the mode is not a field', async () => {
      const pool = (
        await create({
          mode: 'walk_in',
          nameEn: 'Pool',
          nameAr: 'مسبح',
        }).expect(201)
      ).body as FacilityBody;
      const res = await f
        .http('patch', `/staff/facilities/${pool.id}`, s.manager.token, {
          maxGuests: 2,
        })
        .expect(400);
      expect(fields(res)).toEqual([
        { field: 'maxGuests', code: 'FIELD_NOT_ALLOWED' },
      ]);
      const mode = await f
        .http('patch', `/staff/facilities/${pool.id}`, s.manager.token, {
          mode: 'bookable',
        })
        .expect(400);
      expect(fields(mode)).toEqual([
        { field: 'mode', code: 'FIELD_NOT_ALLOWED' },
      ]);
    });

    it('the database keeps a facility’s mode and never deletes one', async () => {
      const id = await f.facility(s.c, s.manager);
      await expect(
        f.inTx(
          s.c,
          (tx) =>
            tx.$executeRaw`UPDATE facilities SET mode = 'walk_in' WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow(/keeps its mode/);
      await expect(
        f.inTx(
          s.c,
          (tx) => tx.$executeRaw`DELETE FROM facilities WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|keeps its mode/);
    });
  });

  describe('hours and peak times', () => {
    it('hours are replaced as a whole, sorted; windows of a day may touch, never overlap', async () => {
      const id = await f.facility(s.c, s.manager, {}, []);
      const res = await f
        .http('put', `/staff/facilities/${id}/hours`, s.manager.token, {
          windows: [w(2, 720, 1320), w(1, 360, 720), w(1, 720, 1320)],
        })
        .expect(200);
      expect((res.body as FacilityBody).hours).toEqual([
        w(1, 360, 720),
        w(1, 720, 1320),
        w(2, 720, 1320),
      ]);
      const bad = await f
        .http('put', `/staff/facilities/${id}/hours`, s.manager.token, {
          windows: [w(1, 360, 720), w(1, 700, 800), w(3, 600, 600)],
        })
        .expect(400);
      expect(fields(bad)).toEqual([
        {
          field: 'windows.1.startMinute',
          code: 'WINDOW_OVERLAP',
          params: { other: 0 },
        },
        { field: 'windows.2.endMinute', code: 'INVALID_SCHEDULE' },
      ]);
      expect((await staffGet(id)).hours).toHaveLength(3);
    });

    it('a peak time lies inside the hours: touching windows cover it as one', async () => {
      const id = await f.facility(s.c, s.manager, {}, [
        w(1, 360, 720),
        w(1, 720, 1320),
      ]);
      await f
        .http('put', `/staff/facilities/${id}/peak-windows`, s.manager.token, {
          windows: [w(1, 660, 780)],
        })
        .expect(200);
      const outside = await f
        .http('put', `/staff/facilities/${id}/peak-windows`, s.manager.token, {
          windows: [w(1, 1080, 1200), w(2, 1080, 1200), w(1, 1260, 1380)],
        })
        .expect(400);
      expect(fields(outside)).toEqual([
        { field: 'windows.1.startMinute', code: 'PEAK_OUTSIDE_HOURS' },
        { field: 'windows.2.startMinute', code: 'PEAK_OUTSIDE_HOURS' },
      ]);
      // Hours that would leave the peak outside are refused until it moves.
      const shrink = await f
        .http('put', `/staff/facilities/${id}/hours`, s.manager.token, {
          windows: [w(1, 360, 700)],
        })
        .expect(400);
      expect(fields(shrink)).toEqual([
        { field: 'windows', code: 'PEAK_OUTSIDE_HOURS' },
      ]);
      expect((await staffGet(id)).peakWindows).toEqual([w(1, 660, 780)]);
    });

    it('a walk-in facility has hours and no peak time', async () => {
      const pool = (
        await create({
          mode: 'walk_in',
          nameEn: 'Pool',
          nameAr: 'مسبح',
        }).expect(201)
      ).body as FacilityBody;
      await f
        .http('put', `/staff/facilities/${pool.id}/hours`, s.manager.token, {
          windows: ALL_WEEK,
        })
        .expect(200);
      const res = await f
        .http(
          'put',
          `/staff/facilities/${pool.id}/peak-windows`,
          s.manager.token,
          {
            windows: [w(1, 600, 660)],
          },
        )
        .expect(409);
      expect(res.body).toMatchObject({ code: 'FACILITY_NOT_BOOKABLE' });
    });
  });

  describe('who sees what', () => {
    it('residents see the active facilities, their hours and how they are booked — never the capacity', async () => {
      const id = await f.facility(s.c, s.manager, {
        nameEn: 'Squash',
        capacity: 2,
      });
      const list = (
        await f.http('get', '/facilities', s.alice.token).expect(200)
      ).body as { data: FacilityBody[] };
      const seen = list.data.find((x) => x.id === id)!;
      expect(seen.hours).toEqual(ALL_WEEK);
      expect(Object.keys(seen.rules!).sort()).toEqual([
        'cancelCutoffMinutes',
        'maxDaysAhead',
        'maxGuests',
        'minMinutesBefore',
        'peakQuota',
        'requiresApproval',
        'requiresMembership',
        'slotMinutes',
        'weeklyQuota',
      ]);
      expect(Object.keys(seen).sort()).toEqual([
        'closures',
        'descriptionAr',
        'descriptionEn',
        'hours',
        'id',
        'mode',
        'nameAr',
        'nameEn',
        'peakWindows',
        'rules',
      ]);

      await f
        .http('patch', `/staff/facilities/${id}`, s.manager.token, {
          active: false,
        })
        .expect(200);
      const after = (
        await f.http('get', '/facilities', s.alice.token).expect(200)
      ).body as { data: FacilityBody[] };
      expect(after.data.map((x) => x.id)).not.toContain(id);
      const gone = await f
        .http('get', `/facilities/${id}`, s.alice.token)
        .expect(404);
      expect(gone.body).toMatchObject({ code: 'FACILITY_NOT_FOUND' });
      // The staff still see it, retired.
      expect((await staffGet(id)).active).toBe(false);
    });

    it('a handler reads the set-up and changes nothing; an accountant and a resident read none of it', async () => {
      const id = await f.facility(s.c, s.manager);
      await f.http('get', '/staff/facilities', s.handler.token).expect(200);
      await f
        .http('get', `/staff/facilities/${id}`, s.handler.token)
        .expect(200);
      await f
        .http('patch', `/staff/facilities/${id}`, s.handler.token, {
          position: 1,
        })
        .expect(403);
      const accountant = await f.accountant(s.c);
      await f.http('get', '/staff/facilities', accountant.token).expect(403);
      await f.http('get', '/facilities', accountant.token).expect(403);
      await f.http('get', '/staff/facilities', s.alice.token).expect(403);
    });
  });
});
