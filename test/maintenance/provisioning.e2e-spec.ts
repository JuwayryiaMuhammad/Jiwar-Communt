import { DEFAULT_CATEGORIES } from '../../src/maintenance/categories/default-categories';
import {
  DEFAULT_CATEGORY_SPECIALTIES,
  DEFAULT_SPECIALTIES,
} from '../../src/maintenance/specialties/default-specialties';
import { DEFAULT_SLA_TARGETS } from '../../src/maintenance/sla/default-sla-targets';
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

  it('gets the default specialties, each category handled by its namesake, and dispatch off (ADR 0033)', async () => {
    const c = await x.compound();
    const { specialties, links, settings } = await x.asManager(c, async () => ({
      specialties: await x.prisma.tenant.specialty.findMany({
        orderBy: { key: 'asc' },
      }),
      links: await x.prisma.tenant.categorySpecialty.findMany({
        include: { category: true, specialty: true },
      }),
      settings:
        await x.prisma.tenant.maintenanceDispatchSettings.findUniqueOrThrow({
          where: { tenantId: c.tenantId },
        }),
    }));
    expect(
      specialties.map((r) => [r.key, r.nameAr, r.nameEn, r.active]),
    ).toEqual(
      [...DEFAULT_SPECIALTIES]
        .sort((p, q) => p.key.localeCompare(q.key))
        .map((d) => [d.key, d.nameAr, d.nameEn, true]),
    );
    expect(
      links
        .map((l) => [l.category.key, l.specialty.key])
        .sort((p, q) => p[0].localeCompare(q[0])),
    ).toEqual(
      DEFAULT_CATEGORY_SPECIALTIES.map((l) => [
        l.categoryKey,
        l.specialtyKey,
      ]).sort((p, q) => p[0].localeCompare(q[0])),
    );
    // A new compound has no technician specialties yet: automatic dispatch
    // stays off until the manager has set them (ADR 0033).
    expect(settings.autoDispatchEnabled).toBe(false);
    expect(settings.weightAssigned.toNumber()).toBe(1);
    expect(settings.weightInProgress.toNumber()).toBe(2);
    expect(settings.weightOnHold.toNumber()).toBe(0);
    expect(settings.multiplierNormal.toNumber()).toBe(1);
    expect(settings.multiplierUrgent.toNumber()).toBe(1.5);
    expect(settings.multiplierEmergency.toNumber()).toBe(3);
  });

  it('gets the SLA off and the default targets for every category (ADR 0034)', async () => {
    const c = await x.compound();
    const { settings, targets, categories } = await x.asManager(
      c,
      async () => ({
        settings:
          await x.prisma.tenant.maintenanceSlaSettings.findUniqueOrThrow({
            where: { tenantId: c.tenantId },
          }),
        targets: await x.prisma.tenant.slaTarget.findMany({
          include: { category: { select: { key: true } } },
        }),
        categories: await x.prisma.tenant.ticketCategory.count(),
      }),
    );
    expect(settings.slaEnabled).toBe(false);
    expect(settings.enabledAt).toBeNull();
    expect(targets).toHaveLength(categories * 3);
    for (const t of targets)
      expect({
        responseMinutes: t.responseMinutes,
        resolutionMinutes: t.resolutionMinutes,
      }).toEqual(DEFAULT_SLA_TARGETS[t.priority]);
    expect(new Set(targets.map((t) => t.category.key)).size).toBe(
      DEFAULT_CATEGORIES.length,
    );
  });
});
