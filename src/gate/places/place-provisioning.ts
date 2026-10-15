import { Injectable, type OnModuleInit } from '@nestjs/common';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantLifecycle } from '../../core/tenant-settings/tenant-lifecycle';
import { DEFAULT_PLACES } from './default-places';

/**
 * What a new compound gets of its places (ADR 0047), in the creation's
 * transaction: the seven defaults. Existing compounds got the same from
 * the migration.
 */
@Injectable()
export class PlaceProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.place.createMany({
      data: DEFAULT_PLACES.map((p) => ({ id: newId(), tenantId, ...p })),
    });
  }
}
