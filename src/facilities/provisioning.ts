import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';

/**
 * What a new compound gets from the facilities domain (ADR 0044), in the
 * creation's transaction: its settings row. No facility: the compound
 * names its own. Existing compounds got the same from the migration.
 */
@Injectable()
export class FacilitiesProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.facilitySettings.create({ data: { tenantId } });
  }
}
