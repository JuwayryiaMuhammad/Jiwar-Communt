import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantLifecycle } from '../../core/tenant-settings/tenant-lifecycle';

/**
 * What a new compound gets from the parcels (ADR 0035), in the creation's
 * transaction: its settings row and its number counter. Existing compounds
 * got the same from the migration.
 */
@Injectable()
export class ParcelProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.parcelSettings.create({ data: { tenantId } });
    await tx.parcelCounter.create({ data: { tenantId } });
  }
}
