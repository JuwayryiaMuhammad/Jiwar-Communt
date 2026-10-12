import {
  DEFAULT_OFFICE_HOURS,
  DEFAULT_TOPICS,
} from '../../src/management/settings/defaults';
import { communityHelpers } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0039: a compound is created with what the management requests need —
 * its settings, its number counter, the five default topics and the default
 * office hours — in the creation's own transaction (TenantLifecycle).
 * Existing compounds got the same from the migration's backfill.
 */
describe('Management requests — a new compound', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
  });

  afterAll(() => h.close());

  it('gets its settings, a counter at zero, the five topics and the office hours', async () => {
    const c = await x.compound();
    const rows = await x.asManager(c, async () => ({
      settings:
        await x.prisma.tenant.managementRequestSettings.findUniqueOrThrow({
          where: { tenantId: c.tenantId },
        }),
      counter: await x.prisma.tenant.managementRequestCounter.findUniqueOrThrow(
        { where: { tenantId: c.tenantId } },
      ),
      topics: await x.prisma.tenant.managementRequestTopic.findMany(),
      hours: await x.prisma.tenant.managementOfficeHours.findMany({
        orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
      }),
    }));
    expect(rows.settings).toMatchObject({
      autoCloseDays: 7,
      appointmentSlotMinutes: 30,
      appointmentSlotCapacity: 1,
    });
    expect(rows.counter.lastNumber).toBe(0);
    const byKey = (p: { key: string }, q: { key: string }) =>
      p.key.localeCompare(q.key);
    expect(
      rows.topics
        .map((t) => ({
          key: t.key,
          nameAr: t.nameAr,
          nameEn: t.nameEn,
          targetResponseHours: t.targetResponseHours,
          active: t.active,
        }))
        .sort(byKey),
    ).toEqual(
      [...DEFAULT_TOPICS].sort(byKey).map((t) => ({ ...t, active: true })),
    );
    // Saturday to Thursday, 09:00 to 17:00; no Friday.
    expect(
      rows.hours.map((w) => [w.weekday, w.startMinute, w.endMinute]),
    ).toEqual(
      DEFAULT_OFFICE_HOURS.map((w) => [w.weekday, w.startMinute, w.endMinute]),
    );
    expect(rows.hours.map((w) => w.weekday)).not.toContain(5);
  });

  it('two compounds each get rows of their own', async () => {
    const [a, b] = [await x.compound(), await x.compound()];
    const ids = async (c: typeof a) =>
      x.asManager(c, async () =>
        (await x.prisma.tenant.managementRequestTopic.findMany()).map(
          (t) => t.id,
        ),
      );
    const [mine, theirs] = [await ids(a), await ids(b)];
    expect(mine).toHaveLength(DEFAULT_TOPICS.length);
    expect(theirs).toHaveLength(DEFAULT_TOPICS.length);
    expect(mine.filter((id) => theirs.includes(id))).toEqual([]);
  });
});
