import { Injectable, type OnModuleInit } from '@nestjs/common';
import { newId } from '../core/common/uuid';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { TenantLifecycle } from '../core/tenant-settings/tenant-lifecycle';
import {
  DEFAULT_OFFICE_HOURS,
  DEFAULT_TOPICS,
  RELEASE_TOPIC,
  SYSTEM_TOPICS,
  UNIT_TOPICS,
} from './settings/defaults';

/**
 * What a new compound gets from the management requests (ADR 0039), in the
 * creation's transaction: its settings row, its number counter, the five
 * default topics, the release topic (ADR 0058) and the system ones
 * (ADR 0060), and the default office hours. Existing compounds got the
 * same from the migration.
 */
@Injectable()
export class ManagementProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.managementRequestSettings.create({ data: { tenantId } });
    await tx.managementRequestCounter.create({ data: { tenantId } });
    await tx.managementRequestTopic.createMany({
      data: [
        ...DEFAULT_TOPICS,
        RELEASE_TOPIC,
        ...SYSTEM_TOPICS,
        ...UNIT_TOPICS,
      ].map((t) => ({
        id: newId(),
        tenantId,
        ...t,
      })),
    });
    await tx.managementOfficeHours.createMany({
      data: DEFAULT_OFFICE_HOURS.map((w) => ({ id: newId(), tenantId, ...w })),
    });
  }
}
