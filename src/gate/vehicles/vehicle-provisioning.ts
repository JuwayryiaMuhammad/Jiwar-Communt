import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantLifecycle } from '../../core/tenant-settings/tenant-lifecycle';

/**
 * What a new compound gets from the vehicles (ADR 0045), in the creation's
 * transaction: its settings row. Existing compounds got the same from the
 * migration. Counters are created on first use.
 */
@Injectable()
export class VehicleProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.vehicleSettings.create({ data: { tenantId } });
  }
}
