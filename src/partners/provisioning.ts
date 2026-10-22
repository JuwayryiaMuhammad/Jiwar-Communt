import { Injectable, type OnModuleInit } from '@nestjs/common';
import { newId } from '../core/common/uuid';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';
import { DEFAULT_SUBCATEGORIES } from './setup/defaults';

/**
 * What a new compound gets from the partners domain (ADR 0060), in the
 * creation's transaction: its settings row and the seeded sub-categories.
 * No partner: the compound lists its own. Existing compounds got the same
 * from the migration.
 */
@Injectable()
export class PartnersProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.partnerSettings.create({ data: { tenantId } });
    await tx.partnerSubcategory.createMany({
      data: DEFAULT_SUBCATEGORIES.map((s) => ({ id: newId(), tenantId, ...s })),
    });
  }
}
