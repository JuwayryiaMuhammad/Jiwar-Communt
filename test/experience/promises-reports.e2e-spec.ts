import { day } from '../setup/compound-clock';
import { experienceHelpers, type ExperienceSetUp } from '../setup/experience';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Body = {
  code: string;
  fields?: { field: string; code: string; params?: object }[];
};

interface Measurement {
  promise: { id: string; titleEn: string };
  measured: boolean;
  items: number;
  value: number | null;
  met: boolean | null;
}

/**
 * ADR 0082: the service promises register, measured where the data exists;
 * the ratings report (by source and building, the low ratings' reasons, the
 * units with repeated low ratings), and the board's section of it: totals
 * only, never a unit, the management's handling among them.
 */
describe('Experience — promises and the ratings report', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof experienceHelpers>;
  let s: ExperienceSetUp;
  const o = (i: number) => s.owners[i - 1];

  beforeAll(async () => {
    h = await createHttpHarness();
    e = experienceHelpers(h);
    s = await e.setUp(4, 3);
  }, 180_000);

  afterAll(() => h.close());

  const manager = () => s.manager.token;

  it('a promise’s terms: hours within a share, an average rating, or none; each refused out of shape', async () => {
    const fields = async (body: object) =>
      (
        (
          await e
            .api('post', '/promises', manager(), {
              titleEn: 'A promise',
              titleAr: 'وعد',
              ...body,
            })
            .expect(400)
        ).body as Body
      ).fields;
    expect(
      await fields({ metric: 'ticket_resolution_hours', target: 48 }),
    ).toEqual([{ field: 'targetShare', code: 'FIELD_REQUIRED' }]);
    expect(
      await fields({ metric: 'request_rating', target: 4, targetShare: 80 }),
    ).toEqual([{ field: 'targetShare', code: 'FIELD_NOT_ALLOWED' }]);
    expect(await fields({ metric: 'partner_rating', target: 6 })).toEqual([
      {
        field: 'target',
        code: 'INVALID_NUMBER',
        params: { min: 1, max: 5 },
      },
    ]);
    expect(await fields({ target: 3 })).toEqual([
      { field: 'target', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const listed = await e
      .api('post', '/promises', manager(), {
        titleEn: 'A welcome visit in the first week',
        titleAr: 'زيارة ترحيب في الأسبوع الأول',
      })
      .expect(201);
    expect(listed.body).toMatchObject({
      metric: null,
      target: null,
      targetShare: null,
      active: true,
    });
    // A change keeps the terms whole: a metric without its target is refused.
    const half = await e
      .api(
        'patch',
        `/promises/${(listed.body as { id: string }).id}`,
        manager(),
        {
          metric: 'request_rating',
        },
      )
      .expect(400);
    expect((half.body as Body).fields).toEqual([
      { field: 'target', code: 'FIELD_REQUIRED' },
    ]);
  });

  it('measured over the compound’s days: the requests’ average rating against its target; one with no metric is listed', async () => {
    await e.lowRatings(s.c, o(1), 2);
    const rating = await e
      .api('post', '/promises', manager(), {
        titleEn: 'Requests rated 4 or better',
        titleAr: 'تقييم 4 فأكثر',
        metric: 'request_rating',
        target: 4,
      })
      .expect(201);
    const answered = await e
      .api('post', '/promises', manager(), {
        titleEn: 'Answered within a day',
        titleAr: 'رد خلال يوم',
        metric: 'request_response_hours',
        target: 24,
        targetShare: 90,
      })
      .expect(201);
    const report = await e
      .api('get', `/promises/report?from=${day(-7)}&to=${day(0)}`, manager())
      .expect(200);
    const items = (report.body as { items: Measurement[] }).items;
    const byId = (id: string) => items.find((m) => m.promise.id === id)!;
    expect(byId((rating.body as { id: string }).id)).toMatchObject({
      measured: true,
      items: 2,
      value: 1,
      met: false,
    });
    // The two requests were never answered: none within the hours.
    expect(byId((answered.body as { id: string }).id)).toMatchObject({
      measured: true,
      value: 0,
      met: false,
    });
    expect(items.some((m) => !m.measured && m.value === null)).toBe(true);
    const long = await e
      .api('get', `/promises/report?from=${day(-400)}&to=${day(0)}`, manager())
      .expect(400);
    expect((long.body as Body).fields).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 366 } },
    ]);
  });

  it('the ratings report: by source and building, the reasons by frequency, the units with repeated low ratings', async () => {
    await e.lowRatings(s.c, o(2), 3);
    const res = await e
      .api('get', `/ratings-report?from=${day(-7)}&to=${day(0)}`, manager())
      .expect(200);
    const body = res.body as {
      totals: { count: number; low: number };
      bySource: { source: string; count: number }[];
      reasons: { code: string; count: number; share: number }[];
      byBuilding: { building: string | null; low: number }[];
      units: { unitId: string; unitCode: string | null; low: number }[];
    };
    expect(body.bySource.map((x) => x.source)).toEqual([
      'ticket',
      'management_request',
      'partner_request',
    ]);
    expect(
      body.bySource.find((x) => x.source === 'management_request')!.count,
    ).toBeGreaterThanOrEqual(3);
    expect(body.reasons[0]).toMatchObject({ code: 'slow', share: 100 });
    expect(body.units.map((u) => u.unitId)).toEqual(
      expect.arrayContaining([o(2).unitId]),
    );
    expect(body.units.find((u) => u.unitId === o(2).unitId)).toMatchObject({
      low: 3,
      unitCode: expect.any(String) as string,
    });
    // Never who rated, never a comment.
    expect(JSON.stringify(body)).not.toContain(o(2).id);
  });

  it('the board’s overview has the experience section: totals only, never a unit', async () => {
    const res = await e
      .http('get', `/board/overview?from=${day(-7)}&to=${day(0)}`, o(1).token)
      .expect(200);
    const section = (
      res.body as { sections: Record<string, Record<string, unknown>> }
    ).sections.experience;
    expect(section).toMatchObject({
      ratings: {
        bySource: {
          management_request: { low: expect.any(Number) as number },
        },
      },
      cases: { openNow: expect.any(Number) as number },
      compensations: { currency: 'EGP' },
    });
    const text = JSON.stringify(section);
    for (const owner of s.owners) {
      expect(text).not.toContain(owner.unitId);
      expect(text).not.toContain(owner.id);
    }
  });
});
