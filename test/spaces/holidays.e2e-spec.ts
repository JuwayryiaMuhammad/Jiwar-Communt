import { newId } from '../../src/core/common/uuid';
import { assetHelpers } from '../setup/assets';
import { dbDate, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, workDaysOf } from '../setup/permits';
import { spacesHelpers } from '../setup/spaces';

interface HolidayBody {
  id: string;
  day: string;
  nameEn: string;
  nameAr: string;
  stopsWorks: boolean;
}

const code = (res: { body: unknown }) => (res.body as { code: string }).code;
const fields = (res: { body: unknown }) =>
  (res.body as { fields: unknown[] }).fields;

/**
 * ADR 0084: the compound's holiday calendar. Kept by `spaces.manage`, read by
 * the apps; its holidays that stop works are the permits' days off (ADR
 * 0049, behaviour unchanged); a facility's day and a planned work date only
 * carry their holiday.
 */
describe('Spaces: the holiday calendar (ADR 0084)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let sp: ReturnType<typeof spacesHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    sp = spacesHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const add = (token: string, body: Record<string, unknown>) =>
    p.http('post', '/staff/holidays', token, {
      nameEn: 'Feast',
      nameAr: 'عيد',
      ...body,
    });

  it('the manager adds, renames and removes holidays; one a day; the apps read the coming year', async () => {
    const c = await p.setUp('Holidays Court');
    const first = (await add(c.manager.token, { day: day(5) }).expect(201))
      .body as HolidayBody;
    expect(first).toMatchObject({ day: day(5), stopsWorks: true });
    const again = await add(c.manager.token, { day: day(5) }).expect(409);
    expect([code(again), (again.body as { params: unknown }).params]).toEqual([
      'HOLIDAY_EXISTS',
      { day: day(5) },
    ]);
    await add(c.manager.token, { day: day(9), stopsWorks: false }).expect(201);
    const changed = (
      await p
        .http('patch', `/staff/holidays/${first.id}`, c.manager.token, {
          nameEn: 'Big feast',
        })
        .expect(200)
    ).body as HolidayBody;
    expect(changed).toMatchObject({ nameEn: 'Big feast', day: day(5) });
    const seen = (
      (await p.http('get', '/community/holidays', c.alice.token).expect(200))
        .body as { data: HolidayBody[] }
    ).data;
    expect(seen.map((x) => [x.day, x.stopsWorks])).toEqual([
      [day(5), true],
      [day(9), false],
    ]);
    await p
      .http('delete', `/staff/holidays/${first.id}`, c.manager.token)
      .expect(204);
    await p
      .http('delete', `/staff/holidays/${first.id}`, c.manager.token)
      .expect(404);
    const audit = await p.v.x.asManager(c.c, () =>
      p.v.x.prisma.tenant.auditLog.findMany({
        where: { action: { startsWith: 'holiday.' } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(audit.map((a) => [a.action, a.metadata])).toEqual([
      ['holiday.created', { day: day(5), stopsWorks: true }],
      ['holiday.created', { day: day(9), stopsWorks: false }],
      ['holiday.changed', { day: day(5) }],
      ['holiday.removed', { day: day(5), stopsWorks: true }],
    ]);
  });

  it('refuses a day too far, a period over a year, too many coming holidays and other roles', async () => {
    const c = await p.setUp('Holidays Limits Court');
    const far = await add(c.manager.token, { day: day(800) }).expect(400);
    expect(fields(far)).toEqual([
      {
        field: 'day',
        code: 'DAY_OUT_OF_RANGE',
        params: { min: day(-366), max: day(731) },
      },
    ]);
    const long = await p
      .http(
        'get',
        `/staff/holidays?from=${day(0)}&to=${day(366)}`,
        c.manager.token,
      )
      .expect(400);
    expect(fields(long)).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 366 } },
    ]);
    await p.v.inTx(c.c, (tx) =>
      tx.compoundHoliday.createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          id: newId(),
          tenantId: c.c.tenantId,
          day: dbDate(day(i + 1)),
          nameEn: 'Day',
          nameAr: 'يوم',
        })),
      }),
    );
    const many = await add(c.manager.token, { day: day(200) }).expect(409);
    expect([code(many), (many.body as { params: unknown }).params]).toEqual([
      'HOLIDAYS_TOO_MANY',
      { max: 100 },
    ]);
    // A past day is not one of the coming hundred.
    await add(c.manager.token, { day: day(-3) }).expect(201);
    await add(c.alice.token, { day: day(300) }).expect(403);
  });

  it('a holiday that stops works is a permits’ day off: a move that day is refused; one that does not stop them is not', async () => {
    const c = await p.setUp('Holidays Permits Court');
    const r = await p.rules(c.alice);
    const [off, on] = workDaysOf(r, 2, 4);
    await add(c.manager.token, { day: off }).expect(201);
    await add(c.manager.token, { day: on, stopsWorks: false }).expect(201);
    const refused = await p.moveRaw(c.alice, c.home.id, { date: off });
    expect([refused.status, fields(refused)]).toEqual([
      400,
      [{ field: 'date', code: 'NOT_A_WORK_DAY' }],
    ]);
    await p.move(c.alice, c.home.id, { date: on });
    const rules = (
      await p.http('get', '/community/permit-rules', c.alice.token).expect(200)
    ).body as { daysOff: string[] };
    expect(rules.daysOff).toEqual([off]);
  });

  it.each([1, 2, 3])(
    'round %i: a move and a day off on its day at once — the move is either made first or refused',
    async () => {
      const c = await p.setUp(`Holidays Race Court ${newId().slice(-6)}`);
      const r = await p.rules(c.alice);
      const [d] = workDaysOf(r, 1, 5);
      const [move, holiday] = await Promise.all([
        p.moveRaw(c.alice, c.home.id, { date: d }),
        add(c.manager.token, { day: d }),
      ]);
      expect(holiday.status).toBe(201);
      if (move.status !== 201)
        expect([move.status, fields(move)]).toEqual([
          400,
          [{ field: 'date', code: 'NOT_A_WORK_DAY' }],
        ]);
    },
  );

  it('a facility’s day carries its holiday; its slots are what its hours make them', async () => {
    const s = await sp.setUp('Holidays Slots Court');
    const court = await sp.facility(s.c, s.manager);
    const before = (await sp.slots(s.alice, court, day(6))).length;
    await add(s.manager.token, { day: day(6), nameEn: 'National day' }).expect(
      201,
    );
    const res = (
      await sp
        .http('get', `/facilities/${court}/slots?date=${day(6)}`, s.alice.token)
        .expect(200)
    ).body as { holiday: { nameEn: string } | null; slots: unknown[] };
    expect(res.holiday).toMatchObject({ nameEn: 'National day' });
    expect(res.slots).toHaveLength(before);
    const plain = (
      await sp
        .http('get', `/facilities/${court}/slots?date=${day(7)}`, s.alice.token)
        .expect(200)
    ).body as { holiday: unknown };
    expect(plain.holiday).toBeNull();
  });

  it('a planned work date on a holiday is flagged, not moved', async () => {
    const a = assetHelpers(h);
    const s = await a.setUp(1);
    const assetId = await a.asset(s);
    const plan = (
      await a
        .http('post', '/maintenance/plans', s.manager.token, {
          assetId,
          title: 'Weekly pump check',
          trigger: 'calendar',
          every: 1,
          unit: 'week',
          anchorOn: day(10),
        })
        .expect(201)
    ).body as { id: string };
    await add(s.manager.token, { day: day(17) }).expect(201);
    const res = await a
      .http(
        'get',
        `/maintenance/plan-calendar?from=${day(0)}&to=${day(24)}`,
        s.manager.token,
      )
      .expect(200);
    const mine = (
      res.body as {
        data: { planId: string; dueOn: string; holiday: unknown }[];
      }
    ).data.filter((e) => e.planId === plan.id);
    expect(mine.map((e) => [e.dueOn, e.holiday !== null])).toEqual([
      [day(10), false],
      [day(17), true],
      [day(24), false],
    ]);
  });
});
