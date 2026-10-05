import { ClsService } from 'nestjs-cls';
import { CODE_ACCESS_CATALOG } from '../../src/core/access/access-catalog';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { DEFAULT_CATEGORIES } from '../../src/maintenance/categories/default-categories';
import {
  DEFAULT_CATEGORY_SPECIALTIES,
  DEFAULT_SPECIALTIES,
} from '../../src/maintenance/specialties/default-specialties';
import { createHttpHarness, type HttpHarness } from './http-app';

/**
 * A compound from the harness is a whole compound: everything
 * TenantsService.provision gives a real one, the domains' defaults included
 * (a compound without its maintenance rows made every sweep fail on it).
 */
describe('Test harness — a compound', () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await createHttpHarness();
  }, 60_000);

  afterAll(() => h.close());

  it('gets its roles, settings and maintenance defaults, as a real compound does', async () => {
    const { id } = await h.createTenant('Harness');
    const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    const rows = await cls.run(async () => {
      cls.set('tenantId', id);
      return h.moduleRef.get(TenantTx).withTenantTx(async (tx) => ({
        roles: await tx.role.count(),
        tenantSettings: await tx.tenantSettings.count(),
        maintenanceSettings: await tx.maintenanceSettings.count(),
        ticketCounters: await tx.ticketCounter.count(),
        categories: await tx.ticketCategory.count(),
        specialties: await tx.specialty.count(),
        categorySpecialties: await tx.categorySpecialty.count(),
        parcelSettings: await tx.parcelSettings.findUnique({
          where: { tenantId: id },
          select: { parcelReminderDays: true, parcelManagerDays: true },
        }),
        parcelCounters: await tx.parcelCounter.count(),
        dispatch: await tx.maintenanceDispatchSettings.findUnique({
          where: { tenantId: id },
          select: { autoDispatchEnabled: true },
        }),
        sla: await tx.maintenanceSlaSettings.findUnique({
          where: { tenantId: id },
          select: { slaEnabled: true },
        }),
        slaTargets: await tx.slaTarget.count(),
      }));
    });
    expect(rows).toEqual({
      roles: CODE_ACCESS_CATALOG.defaultRoles.length,
      tenantSettings: 1,
      maintenanceSettings: 1,
      ticketCounters: 1,
      categories: DEFAULT_CATEGORIES.length,
      specialties: DEFAULT_SPECIALTIES.length,
      categorySpecialties: DEFAULT_CATEGORY_SPECIALTIES.length,
      parcelSettings: { parcelReminderDays: 3, parcelManagerDays: 14 },
      parcelCounters: 1,
      dispatch: { autoDispatchEnabled: false },
      sla: { slaEnabled: false },
      slaTargets: DEFAULT_CATEGORIES.length * 3,
    });
  });
});
