import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

/**
 * What a unit owes the compound, as finance reads it (ADR 0083). Community
 * holds the moves and the ownership transfers but cannot import finance
 * (ADR 0046): finance registers its one reader at startup, as with
 * MoveSteps and WorksCompletions, and a missing one stops the start. The
 * amount is the clearance's own (ADR 0062): what every open invoice of the
 * unit still owes, open disputes included. No second computation.
 */
export interface UnitDuesReader {
  /**
   * What each unit owes now, a decimal string with two places ("0.00" when
   * nothing), read in the caller's tenant transaction without a lock: for
   * a list or a page.
   */
  owed(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, string>>;
  /**
   * What the unit owes, read under finance's own lock on the unit — the one
   * every invoice, payment and credit note takes — held to the end of the
   * caller's transaction: a decision taken on it (a transfer's dues gate)
   * cannot be overtaken by a payment or an invoice landing meanwhile. Last
   * in the caller's lock order.
   */
  lockAndRead(tx: TenantTxClient, unitId: string): Promise<string>;
}

@Injectable()
export class UnitDues implements OnApplicationBootstrap {
  private reader: UnitDuesReader | null = null;

  register(reader: UnitDuesReader): void {
    if (this.reader) throw new Error('Unit dues reader registered twice');
    this.reader = reader;
  }

  owed(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, string>> {
    return this.require().owed(tx, unitIds);
  }

  lockAndRead(tx: TenantTxClient, unitId: string): Promise<string> {
    return this.require().lockAndRead(tx, unitId);
  }

  /** Whether an amount read here is above zero. */
  static owes(amount: string): boolean {
    return Number(amount) > 0;
  }

  private require(): UnitDuesReader {
    if (!this.reader) throw new Error('No unit dues reader');
    return this.reader;
  }

  onApplicationBootstrap(): void {
    if (!this.reader) throw new Error('Unit dues reader missing');
  }
}
