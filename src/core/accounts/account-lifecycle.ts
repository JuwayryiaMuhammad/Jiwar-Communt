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
 * How core tells domains that an account changed, without importing them
 * (ADR 0015). Domains register handlers at startup; AccountWriter runs them
 * inside its own transaction, so their writes commit or roll back with the
 * status change, and hands back their after-commit work (emails).
 */
@Injectable()
export class AccountLifecycle {
  private readonly deactivation: DeactivationHandler[] = [];
  private readonly freezing: AccountHandler[] = [];
  private readonly reactivation: AccountHandler[] = [];

  onDeactivated(handler: DeactivationHandler): void {
    this.deactivation.push(handler);
  }

  onFrozen(handler: AccountHandler): void {
    this.freezing.push(handler);
  }

  onReactivated(handler: AccountHandler): void {
    this.reactivation.push(handler);
  }

  async frozen(
    tx: TenantTxClient,
    account: { id: string; tenantId: string },
  ): Promise<void> {
    for (const handler of this.freezing) await handler(tx, account);
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
