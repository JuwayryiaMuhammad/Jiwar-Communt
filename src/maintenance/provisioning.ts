import { Injectable, type OnModuleInit } from '@nestjs/common';
import { newId } from '../core/common/uuid';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';
import { DEFAULT_CATEGORIES } from './categories/default-categories';
import { DEFAULT_PREVENTIVE_SERVICES } from './preventive/default-preventive-services';
import { defaultTargetRows } from './sla/default-sla-targets';
import {
  DEFAULT_CATEGORY_SPECIALTIES,
  DEFAULT_SPECIALTIES,
} from './specialties/default-specialties';

/**
 * What a new compound gets from maintenance (ADR 0032, 0033), in the
 * creation's transaction: the default categories, its settings row and its
 * ticket counter, the default specialties (each category handled by its
 * namesake) and the dispatch settings, with automatic dispatch off until
 * the manager has given technicians their specialties; the SLA settings,
 * off, and the default SLA targets of every category (ADR 0034); the
 * default preventive services (ADR 0038). Existing
 * compounds got the same from the migrations.
 */
@Injectable()
export class MaintenanceProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.maintenanceSettings.create({ data: { tenantId } });
    await tx.ticketCounter.create({ data: { tenantId } });
    await tx.ticketCategory.createMany({
      data: DEFAULT_CATEGORIES.map((c) => ({
        id: newId(),
        tenantId,
        key: c.key,
        nameAr: c.nameAr,
        nameEn: c.nameEn,
        defaultPriority: c.defaultPriority,
        commonAreaAllowed: c.commonAreaAllowed,
      })),
    });
    await tx.maintenanceDispatchSettings.create({ data: { tenantId } });
    const specialties = new Map(
      DEFAULT_SPECIALTIES.map((s) => [s.key, newId()]),
    );
    await tx.specialty.createMany({
      data: DEFAULT_SPECIALTIES.map((s) => ({
        id: specialties.get(s.key)!,
        tenantId,
        key: s.key,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
      })),
    });
    const categories = await tx.ticketCategory.findMany({
      select: { id: true, key: true },
    });
    await tx.maintenanceSlaSettings.create({ data: { tenantId } });
    await tx.slaTarget.createMany({
      data: categories.flatMap((c) => defaultTargetRows(tenantId, c.id)),
    });
    const categoryIds = new Map(categories.map((c) => [c.key, c.id]));
    await tx.categorySpecialty.createMany({
      data: DEFAULT_CATEGORY_SPECIALTIES.map((l) => ({
        tenantId,
        categoryId: categoryIds.get(l.categoryKey)!,
        specialtyId: specialties.get(l.specialtyKey)!,
      })),
    });
    await tx.preventiveService.createMany({
      data: DEFAULT_PREVENTIVE_SERVICES.map((s) => ({
        id: newId(),
        tenantId,
        key: s.key,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        categoryId: categoryIds.get(s.categoryKey)!,
        position: s.position,
      })),
    });
  }
}
