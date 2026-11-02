import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';
import {
  DEFAULT_DEADLINE_DAYS,
  SETTING_TYPES,
} from './approvals/approval-rules';

/**
 * What a new compound gets from governance (ADR 0055), in the creation's
 * transaction: a settings row per approval type and for appeals to the
 * board, with the default deadlines and no threshold. Existing compounds
 * got the same from the migration.
 */
@Injectable()
export class GovernanceProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.governanceApprovalSetting.createMany({
      data: SETTING_TYPES.map((type) => ({
        tenantId,
        type,
        deadlineDays: DEFAULT_DEADLINE_DAYS[type],
        // The manager's limit for one expense binds from the start (ADR
        // 0055), and so does a compensation's (ADR 0082); a waiver's and a
        // plan's bind once the compound says so (ADR 0073).
        binding:
          type === 'major_contract' || type === 'compensation_above_limit',
      })),
    });
  }
}
