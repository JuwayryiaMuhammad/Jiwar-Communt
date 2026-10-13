import { Injectable, type OnModuleInit } from '@nestjs/common';
import { newId } from '../core/common/uuid';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';
import { DEFAULT_SUGGESTION_TOPICS } from './settings/defaults';

/**
 * What a new compound gets from the community life (ADR 0040), in the
 * creation's transaction: its settings row and the six default suggestion
 * topics. Existing compounds got the same from the migration.
 */
@Injectable()
export class EngagementProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.engagementSettings.create({ data: { tenantId } });
    await tx.suggestionTopic.createMany({
      data: DEFAULT_SUGGESTION_TOPICS.map((t) => ({
        id: newId(),
        tenantId,
        ...t,
      })),
    });
  }
}
