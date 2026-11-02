import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';
import { TenantLifecycle } from '../tenant-settings/tenant-lifecycle';

/**
 * What a new compound gets of the holiday calendar (ADR 0084), in the
 * creation's transaction: its lock row, and no holiday. Existing compounds
 * got the same from the migration, with their days off moved in.
 */
@Injectable()
export class HolidayProvisioning implements OnModuleInit {
  constructor(private readonly tenants: TenantLifecycle) {}

  onModuleInit(): void {
    this.tenants.onCreated((tx, tenantId) => this.provision(tx, tenantId));
  }

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.holidayCalendar.create({ data: { tenantId } });
  }
}
