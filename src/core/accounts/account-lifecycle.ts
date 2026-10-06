import { Injectable, type Logger } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** Work to run once the transaction that caused it has committed. */
export type AfterCommit = () => Promise<void>;

export type DeactivationHandler = (
  tx: TenantTxClient,
  account: { id: string; tenantId: string },
) => Promise<AfterCommit[]>;

/** Freeze and reactivation (ADR 0023): the domain's side, in core's tx. */
export type AccountHandler = (
  tx: TenantTxClient,
  account: { id: string; tenantId: string },
) => Promise<void>;

/**
 * What keeps an account from being erased now (ADR 0036), as blocker codes;
 * read under the account's row lock, when a deletion is asked for and again
 * in the transaction that executes it.
 */
export type DeletionBlockerCheck = (
  tx: TenantTxClient,
  account: { id: string; tenantId: string },
) => Promise<string[]>;

/**
 * A freeze handler may also hand back work to run after the freeze commits
 * (maintenance retries the tickets it released, ADR 0033).
 */
export type FreezeHandler = (
  tx: TenantTxClient,
  account: { id: string; tenantId: string },
) => Promise<void | AfterCommit[]>;

/**
 * How core tells domains that an account changed, without importing them
 * (ADR 0015). Domains register handlers at startup; AccountWriter runs them
 * inside its own transaction, so their writes commit or roll back with the
 * status change, and hands back their after-commit work (emails).
 */
@Injectable()
export class AccountLifecycle {
  private readonly deactivation: DeactivationHandler[] = [];
  private readonly freezing: FreezeHandler[] = [];
  private readonly reactivation: AccountHandler[] = [];
  private readonly erasure: DeactivationHandler[] = [];
  private readonly sessionsRevokedAll: AccountHandler[] = [];
  private readonly residence: AccountHandler[] = [];
  private readonly blockerChecks: DeletionBlockerCheck[] = [];

  /** A domain's reasons an account cannot be erased yet (ADR 0036). */
  onDeletionCheck(check: DeletionBlockerCheck): void {
    this.blockerChecks.push(check);
  }

  async deletionBlockers(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<string[]> {
    const codes: string[] = [];
    for (const check of this.blockerChecks)
      codes.push(...(await check(tx, account)));
    return codes;
  }

  /**
   * "That wasn't me" (ADR 0031): every session of the account just ended.
   * Whatever a session could have set up for later (an entry credential)
   * ends with them.
   */
  onSessionsRevoked(handler: AccountHandler): void {
    this.sessionsRevokedAll.push(handler);
  }

  async sessionsRevoked(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<void> {
    for (const handler of this.sessionsRevokedAll) await handler(tx, account);
  }

  /**
   * Where the account lives may have changed (an occupancy ended, a
   * residence flag turned off, a membership ended): the domains that keep
   * something for people who live in a unit re-check, in the same
   * transaction and after the writes (ADR 0031). Handlers re-evaluate; they
   * are not told what changed.
   */
  onResidenceChanged(handler: AccountHandler): void {
    this.residence.push(handler);
  }

  async residenceChanged(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<void> {
    for (const handler of this.residence) await handler(tx, account);
  }

  /** Before an erasure: the domains end what hangs off the account. */
  onErasing(handler: DeactivationHandler): void {
    this.erasure.push(handler);
  }

  async erasing(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<AfterCommit[]> {
    const tasks: AfterCommit[] = [];
    for (const handler of this.erasure)
      tasks.push(...(await handler(tx, account)));
    return tasks;
  }

  onDeactivated(handler: DeactivationHandler): void {
    this.deactivation.push(handler);
  }

  onFrozen(handler: FreezeHandler): void {
    this.freezing.push(handler);
  }

  onReactivated(handler: AccountHandler): void {
    this.reactivation.push(handler);
  }

  async frozen(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<AfterCommit[]> {
    const tasks: AfterCommit[] = [];
    for (const handler of this.freezing)
      tasks.push(...((await handler(tx, account)) ?? []));
    return tasks;
  }

  async reactivated(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<void> {
    for (const handler of this.reactivation) await handler(tx, account);
  }

  async deactivated(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<AfterCommit[]> {
    const tasks: AfterCommit[] = [];
    for (const handler of this.deactivation) {
      tasks.push(...(await handler(tx, account)));
    }
    return tasks;
  }
}

/**
 * Runs after-commit work in order. A failure is logged (by error class only)
 * and never undoes the committed action or stops the remaining tasks.
 */
export async function runAfterCommit(
  tasks: AfterCommit[],
  logger: Logger,
): Promise<void> {
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      logger.error(
        `after-commit task failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
    }
  }
}
