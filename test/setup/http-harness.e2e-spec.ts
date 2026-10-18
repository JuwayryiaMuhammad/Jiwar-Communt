import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClsService } from 'nestjs-cls';
import { CODE_ACCESS_CATALOG } from '../../src/core/access/access-catalog';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { DEFAULT_CATEGORIES } from '../../src/maintenance/categories/default-categories';
import {
  DEFAULT_CATEGORY_SPECIALTIES,
  DEFAULT_SPECIALTIES,
} from '../../src/maintenance/specialties/default-specialties';
import { API, createHttpHarness, type HttpHarness } from './http-app';
import { leakText } from './leak-text';

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

  it('listens once: twenty requests at once reuse its port and add no listener', async () => {
    const server = h.app.getHttpServer() as Server;
    const before = (server.address() as AddressInfo).port;
    const listeners = () =>
      ['listening', 'error', 'close'].map((e) => server.listenerCount(e));
    const counts = listeners();
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => h.http().get(API)),
    );
    expect(answers.map((a) => a.status)).toEqual(Array(20).fill(200));
    expect(listeners()).toEqual(counts);
    expect((server.address() as AddressInfo).port).toBe(before);
  });
});

describe('Test harness — leakText', () => {
  it('takes out ids, instants and digests, never the words or short codes', () => {
    const text = leakText({
      id: '01a102b6-6253-74a0-9456-96e7c9d52601',
      at: '2026-10-18T10:45:56.456Z',
      hash: 'd418826836142d030db0cb261c6e8f48f9664b936803d734c676fe8be7e7775b',
      plate: 'ق ب ط 456',
      reason: 'plans_changed',
    });
    expect(text).toBe(
      '{"id":"<id>","at":"<at>","hash":"<hex>","plate":"ق ب ط 456","reason":"plans_changed"}',
    );
  });
});
