import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** A vendor as a spend names it: its id and its name now. */
export interface VendorRef {
  id: string;
  name: string;
}

/**
 * The vendor a spend names, its row shared-locked in the caller's tenant
 * transaction (so it is not suspended under the spend): by its id, or by
 * its name (whatever the case; null when none has it). Refuses with
 * VENDOR_NOT_FOUND (an id) or VENDOR_SUSPENDED.
 */
export type VendorResolver = (
  tx: TenantTxClient,
  by: { vendorId: string } | { name: string },
) => Promise<VendorRef | null>;

/**
 * The compound's vendors (ADR 0077) as finance reads them: an expense may
 * name one, but finance imports no other domain (ADR 0046), and the
 * register is maintenance's. Maintenance registers the one resolver at
 * startup, as the works completions' reader is; a missing one stops the
 * start.
 */
@Injectable()
export class VendorDirectory implements OnApplicationBootstrap {
  private resolver: VendorResolver | null = null;

  register(resolver: VendorResolver): void {
    if (this.resolver) throw new Error('Vendor resolver registered twice');
    this.resolver = resolver;
  }

  forSpend(
    tx: TenantTxClient,
    by: { vendorId: string } | { name: string },
  ): Promise<VendorRef | null> {
    if (!this.resolver) throw new Error('No vendor resolver');
    return this.resolver(tx, by);
  }

  onApplicationBootstrap(): void {
    if (!this.resolver) throw new Error('Vendor resolver missing');
  }
}
