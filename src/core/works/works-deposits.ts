import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** A finishing-works deposit named on a works permit (ADR 0074). */
export interface WorksDeposit {
  id: string;
  /** `DP-` and the number, finance's own. */
  number: string;
  amount: Prisma.Decimal;
  /** What the management still holds of it. */
  held: Prisma.Decimal;
}

/** What finance implements. */
export interface WorksDepositsImpl {
  /**
   * The deposit named on each permit, by permit id (one per permit at
   * most); `share` locks their rows FOR SHARE, so a settlement waits for
   * the caller.
   */
  ofPermits(
    tx: TenantTxClient,
    permitIds: readonly string[],
    lock?: 'share',
  ): Promise<Map<string, WorksDeposit>>;
  /**
   * Takes what a settled damage claim asks from the deposit named on its
   * permit, as far as it holds: a `damage` deduction, its row FOR UPDATE.
   * Returns what was taken (zero with no deposit, or nothing held). The
   * caller holds the unit's finance lock (Charges.lockUnit).
   */
  deductForClaim(
    tx: TenantTxClient,
    q: { permitId: string; amount: Prisma.Decimal; claimId: string },
  ): Promise<Prisma.Decimal>;
}

/** What the gate answers finance about a permit a deposit names. */
export interface WorksPermitReaders {
  /** The works permit's unit, or null for any other permit, or none. */
  unitOf(tx: TenantTxClient, permitId: string): Promise<string | null>;
  /** The permit's damage claims not yet settled or withdrawn. */
  openClaims(tx: TenantTxClient, permitId: string): Promise<number>;
}

/**
 * A works permit's finishing-works deposit (ADR 0074), between finance,
 * which holds the deposits, and the gate, which holds the permits: neither
 * imports the other (ADR 0015, 0044). Finance implements the deposits'
 * side at startup and the gate registers its readers, as WorksCompletions
 * (ADR 0063) is used the other way; a missing side stops the start.
 */
@Injectable()
export class WorksDeposits implements OnApplicationBootstrap {
  private impl: WorksDepositsImpl | null = null;
  private readers: WorksPermitReaders | null = null;

  /** Finance, at startup: once. */
  implement(impl: WorksDepositsImpl): void {
    if (this.impl) throw new Error('Works deposits implemented twice');
    this.impl = impl;
  }

  /** The gate, at startup: once. */
  registerPermits(readers: WorksPermitReaders): void {
    if (this.readers) throw new Error('Works permit readers registered twice');
    this.readers = readers;
  }

  ofPermits(
    tx: TenantTxClient,
    permitIds: readonly string[],
    lock?: 'share',
  ): Promise<Map<string, WorksDeposit>> {
    if (!permitIds.length)
      return Promise.resolve(new Map<string, WorksDeposit>());
    return this.need().ofPermits(tx, permitIds, lock);
  }

  async ofPermit(
    tx: TenantTxClient,
    permitId: string,
    lock?: 'share',
  ): Promise<WorksDeposit | null> {
    return (
      (await this.need().ofPermits(tx, [permitId], lock)).get(permitId) ?? null
    );
  }

  deductForClaim(
    tx: TenantTxClient,
    q: { permitId: string; amount: Prisma.Decimal; claimId: string },
  ): Promise<Prisma.Decimal> {
    return this.need().deductForClaim(tx, q);
  }

  unitOf(tx: TenantTxClient, permitId: string): Promise<string | null> {
    return this.permits().unitOf(tx, permitId);
  }

  openClaims(tx: TenantTxClient, permitId: string): Promise<number> {
    return this.permits().openClaims(tx, permitId);
  }

  onApplicationBootstrap(): void {
    if (!this.impl) throw new Error('Works deposits not implemented');
    if (!this.readers) throw new Error('Works permit readers missing');
  }

  private need(): WorksDepositsImpl {
    if (!this.impl)
      throw new Error('Works deposits: finance has not implemented the port');
    return this.impl;
  }

  private permits(): WorksPermitReaders {
    if (!this.readers)
      throw new Error(
        'Works deposits: the gate has not registered its readers',
      );
    return this.readers;
  }
}
