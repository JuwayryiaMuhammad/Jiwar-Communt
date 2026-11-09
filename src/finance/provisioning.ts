import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';

/**
 * What a new compound gets from the finance domain (ADR 0046), in the
 * creation's transaction: its settings row, online payment off and no
 * gateway, and the standard chart of accounts (ADR 0092, the migration's
 * `gl_seed_chart`). Existing compounds got the same from the migrations.
 */
@Injectable()
export class FinanceProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.financeSettings.create({ data: { tenantId } });
    await tx.$queryRaw`SELECT gl_seed_chart(${tenantId}::uuid)::text`;
  }
}
