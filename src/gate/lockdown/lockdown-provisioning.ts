import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantLifecycle } from '../../core/tenant-settings/tenant-lifecycle';

/**
 * What a new compound gets of the lockdown (ADR 0053), in the creation's
 * transaction: the row every lockdown decision locks. Existing compounds
 * got the same from the migration.
 */
@Injectable()
export class LockdownProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.gateLockdownState.create({ data: { tenantId } });
  }
}
