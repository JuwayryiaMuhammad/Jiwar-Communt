import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** A domain's part of creating a compound, in the compound's transaction. */
export type TenantCreatedHandler = (
  tx: TenantTxClient,
  tenantId: string,
) => Promise<void>;

/**
 * How core tells domains that a compound was just created, without
 * importing them (ADR 0015): maintenance seeds its categories, settings and
 * ticket counter here (ADR 0032). Handlers run inside the creation's
 * transaction, so a compound never exists without them.
 */
@Injectable()
export class TenantLifecycle {
  private readonly created: TenantCreatedHandler[] = [];

  onCreated(handler: TenantCreatedHandler): void {
    this.created.push(handler);
  }

  async tenantCreated(tx: TenantTxClient, tenantId: string): Promise<void> {
    for (const handler of this.created) await handler(tx, tenantId);
  }
}
