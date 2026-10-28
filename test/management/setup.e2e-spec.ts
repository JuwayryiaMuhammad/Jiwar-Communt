import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers, type ManagementSetUp } from '../setup/management';

/**
 * ADR 0039: what the manager sets up — the topics with their response
 * targets, the auto-close days and the appointment slots, and the office
 * hours. All of it with `requests.manage`.
 */
describe('Management requests — topics, settings and office hours', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
  }, 60_000);

  afterAll(() => h.close());

  type Topic = {
    id: string;
    key: string;
    nameEn: string;
    targetResponseHours: number;
    active?: boolean;
  };
  const topics = async (path: string, token: string) =>
    ((await m.http('get', path, token).expect(200)).body as { data: Topic[] })
      .data;

  describe('topics', () => {
    it('the manager sees the five and the system one, by key; a resident sees the active ones a person may pick, without the state', async () => {
      const all = await topics('/management/request-topics', s.manager.token);
      expect(all.map((t) => [t.key, t.targetResponseHours, t.active])).toEqual([
        ['billing_fees', 48, true],
        ['documents', 72, true],
        ['facilities', 72, true],
        ['general', 48, true],
        // A complaint against a partner opens on it (ADR 0060).
        ['partner_service', 48, true],
        // ADR 0058: the request to release a hold.
        ['release_request', 48, true],
        ['security_gate', 24, true],
        // ADR 0063: about a resident's unit.
        ['utilities', 72, true],
      ]);
      const offered = await topics('/management-request-topics', s.owner.token);
      expect(offered.map((t) => t.key)).toEqual(
        all.map((t) => t.key).filter((k) => k !== 'partner_service'),
      );
      expect(Object.keys(offered[0]).sort()).toEqual([
        'id',
        'key',
        'nameAr',
        'nameEn',
        'owner',
        'targetResponseHours',
      ]);
    });

    it('a new topic is offered; a retired one is not, and stays in the manager’s list', async () => {
      const created = await m
        .http('post', '/management/request-topics', s.manager.token, {
          key: 'parking',
          nameAr: ' مواقف ',
          nameEn: ' Parking ',
          targetResponseHours: 12,
        })
        .expect(201);
      const topic = created.body as Topic;
      expect(topic).toMatchObject({
        key: 'parking',
        nameEn: 'Parking',
        targetResponseHours: 12,
        active: true,
      });
      expect(
        (await topics('/management-request-topics', s.owner.token)).map(
          (t) => t.key,
        ),
      ).toContain('parking');

      const retired = await m
        .http(
          'patch',
          `/management/request-topics/${topic.id}`,
          s.manager.token,
          { active: false, targetResponseHours: 36 },
        )
        .expect(200);
      expect(retired.body).toMatchObject({
        key: 'parking',
        active: false,
        targetResponseHours: 36,
      });
      expect(
        (await topics('/management-request-topics', s.owner.token)).map(
          (t) => t.key,
        ),
      ).not.toContain('parking');
      expect(
        (await topics('/management/request-topics', s.manager.token)).map(
          (t) => t.key,
        ),
      ).toContain('parking');
    });

    it('a key is unique in the compound and never changes', async () => {
      const dup = await m
        .http('post', '/management/request-topics', s.manager.token, {
          key: 'general',
          nameAr: 'عام',
          nameEn: 'General again',
          targetResponseHours: 24,
        })
        .expect(409);
      expect(dup.body).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
        fields: [{ field: 'key', code: 'DUPLICATE_VALUE' }],
      });
      const [general] = (
        await topics('/management/request-topics', s.manager.token)
      ).filter((t) => t.key === 'general');
      const res = await m
        .http(
          'patch',
          `/management/request-topics/${general.id}`,
          s.manager.token,
          { key: 'renamed' },
        )
        .expect(400);
      expect(res.body).toMatchObject({
        fields: [{ field: 'key', code: 'FIELD_NOT_ALLOWED' }],
      });
    });

    it('only requests.manage sets topics up: a resident is refused', async () => {
      await m
        .http('get', '/management/request-topics', s.owner.token)
        .expect(403);
      await m
        .http('post', '/management/request-topics', s.owner.token, {
          key: 'mine',
          nameAr: 'لي',
          nameEn: 'Mine',
          targetResponseHours: 1,
        })
        .expect(403);
    });
  });

  describe('settings', () => {
    it('start at 7 days, 30 minutes and one per slot', async () => {
      const res = await m
        .http('get', '/management/request-settings', s.manager.token)
        .expect(200);
      expect(res.body).toEqual({
        autoCloseDays: 7,
        appointmentSlotMinutes: 30,
        appointmentSlotCapacity: 1,
      });
    });

    it('a part of them changes alone', async () => {
      const res = await m
        .http('patch', '/management/request-settings', s.manager.token, {
          autoCloseDays: 10,
        })
        .expect(200);
      expect(res.body).toEqual({
        autoCloseDays: 10,
        appointmentSlotMinutes: 30,
        appointmentSlotCapacity: 1,
      });
    });

    it.each([
      ['autoCloseDays', 91, { min: 1, max: 90 }],
      ['appointmentSlotMinutes', 241, { min: 10, max: 240 }],
      ['appointmentSlotCapacity', 0, { min: 1, max: 50 }],
    ])('%s = %s is out of range', async (field, value, params) => {
      const res = await m
        .http('patch', '/management/request-settings', s.manager.token, {
          [field]: value,
        })
        .expect(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [{ field, code: 'INVALID_NUMBER', params }],
      });
    });

    it('a resident neither reads nor writes them', async () => {
      await m
        .http('get', '/management/request-settings', s.owner.token)
        .expect(403);
      await m
        .http('patch', '/management/request-settings', s.owner.token, {
          autoCloseDays: 1,
        })
        .expect(403);
    });
  });

  describe('office hours', () => {
    const put = (windows: object[], token = s.manager.token) =>
      m.http('put', '/management/office-hours', token, { windows });
    const w = (weekday: number, startMinute: number, endMinute: number) => ({
      weekday,
      startMinute,
      endMinute,
    });

    it('start Saturday to Thursday, 09:00 to 17:00', async () => {
      const res = await m
        .http('get', '/management/office-hours', s.manager.token)
        .expect(200);
      expect(res.body).toEqual({
        windows: [0, 1, 2, 3, 4, 6].map((d) => w(d, 540, 1020)),
      });
    });

    it('the set is replaced as a whole and comes back by weekday, then start', async () => {
      const res = await put([
        w(6, 600, 720),
        w(0, 780, 1020),
        w(0, 540, 780),
      ]).expect(200);
      const sorted = [w(0, 540, 780), w(0, 780, 1020), w(6, 600, 720)];
      expect(res.body).toEqual({ windows: sorted });
      expect(
        (
          await m
            .http('get', '/management/office-hours', s.manager.token)
            .expect(200)
        ).body,
      ).toEqual({ windows: sorted });
    });

    it('an overlap of one weekday is refused and names both windows; nothing changes', async () => {
      const before = (
        await m
          .http('get', '/management/office-hours', s.manager.token)
          .expect(200)
      ).body as object;
      const res = await put([
        w(1, 540, 720),
        w(2, 540, 720),
        w(1, 700, 900),
      ]).expect(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [
          {
            field: 'windows.2.startMinute',
            code: 'OFFICE_HOURS_OVERLAP',
            params: { other: 0 },
          },
        ],
      });
      const ends = await put([w(1, 720, 720)]).expect(400);
      expect(ends.body).toMatchObject({
        fields: [{ field: 'windows.0.endMinute', code: 'INVALID_SCHEDULE' }],
      });
      expect(
        (
          await m
            .http('get', '/management/office-hours', s.manager.token)
            .expect(200)
        ).body,
      ).toEqual(before);
    });

    it('an empty set closes the office', async () => {
      expect((await put([]).expect(200)).body).toEqual({ windows: [] });
    });

    it('two managers saving at once leave one of the two sets, never a mix', async () => {
      const first = [w(1, 60, 120), w(2, 60, 120)];
      const second = [w(3, 600, 660), w(4, 600, 660), w(5, 600, 660)];
      for (let round = 0; round < 5; round++) {
        const [p, q] = await Promise.all([put(first), put(second)]);
        expect([p.status, q.status]).toEqual([200, 200]);
        const { windows } = (
          await m
            .http('get', '/management/office-hours', s.manager.token)
            .expect(200)
        ).body as { windows: object[] };
        expect([first, second]).toContainEqual(windows);
      }
    });

    it('a resident neither reads nor replaces them', async () => {
      await m
        .http('get', '/management/office-hours', s.owner.token)
        .expect(403);
      await put([], s.owner.token).expect(403);
    });
  });
});
