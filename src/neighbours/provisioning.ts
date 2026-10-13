import { Injectable, type OnModuleInit } from '@nestjs/common';
import { newId } from '../core/common/uuid';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';
import { DEFAULT_COMPLAINT_CATEGORIES } from './settings/defaults';

/**
 * What a new compound gets from the neighbours domain (ADR 0042), in the
 * creation's transaction: its settings row, its complaint counter, an empty
 * welcome template and the eight default complaint categories. Existing
 * compounds got the same from the migrations.
 */
@Injectable()
export class NeighboursProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.neighbourSettings.create({ data: { tenantId } });
    await tx.neighbourComplaintCounter.create({ data: { tenantId } });
    await tx.neighbourWelcomeTemplate.create({ data: { tenantId } });
    await tx.neighbourComplaintCategory.createMany({
      data: DEFAULT_COMPLAINT_CATEGORIES.map((c) => ({
        id: newId(),
        tenantId,
        ...c,
      })),
    });
  }
}
