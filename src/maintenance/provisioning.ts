import { Injectable, type OnModuleInit } from '@nestjs/common';
import { newId } from '../core/common/uuid';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';
import { DEFAULT_CATEGORIES } from './categories/default-categories';

/**
 * What a new compound gets from maintenance (ADR 0032), in the creation's
 * transaction: the default categories, its settings row and its ticket
 * counter. Existing compounds got the same from the migration.
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
  }
}
