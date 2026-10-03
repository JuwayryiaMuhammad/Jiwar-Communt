import { DEFAULT_CATEGORIES } from '../../src/maintenance/categories/default-categories';
import { communityHelpers } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0032: a compound is created with what maintenance needs — the five
 * default categories, its settings and its ticket counter — in the
 * creation's own transaction (TenantLifecycle). Existing compounds got the
 * same from the migration's backfill.
 */
describe('Maintenance — a new compound', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
  });

  afterAll(() => h.close());

  it('gets the default categories, its settings and a counter at zero', async () => {
    const c = await x.compound();
    const [categories, settings, counter] = await x.asManager(c, () =>
      Promise.all([
        x.prisma.tenant.ticketCategory.findMany({ orderBy: { key: 'asc' } }),
        x.prisma.tenant.maintenanceSettings.findUniqueOrThrow({
          where: { tenantId: c.tenantId },
        }),
        x.prisma.tenant.ticketCounter.findUniqueOrThrow({
          where: { tenantId: c.tenantId },
        }),
      ]),
    );
    expect(
      categories.map((r) => ({
        key: r.key,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        defaultPriority: r.defaultPriority,
        commonAreaAllowed: r.commonAreaAllowed,
        active: r.active,
      })),
    ).toEqual(
      [...DEFAULT_CATEGORIES]
        .sort((p, q) => p.key.localeCompare(q.key))
        .map((d) => ({ ...d, active: true })),
    );
    expect(settings).toMatchObject({
      autoCloseHours: 72,
      reopenDays: 7,
      maxReportPhotos: 5,
    });
    expect(counter.lastNumber).toBe(0);
  });
});
