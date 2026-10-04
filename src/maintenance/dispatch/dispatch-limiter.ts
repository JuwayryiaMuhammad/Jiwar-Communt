import { Injectable } from '@nestjs/common';

/** After a decision timed out on the dispatch lock, skip for this long. */
export const BUSY_BACKOFF_MS = 2000;

/**
 * Keeps the engine's waiting off the database pool (ADR 0033).
 *
 * A transaction that waits for the compound's dispatch lock holds a pool
 * connection while it waits. Many tickets created at once in one compound
 * would all wait on the same lock and could take every connection, so a
 * request that needs nothing from dispatch would wait for one. Two guards:
 *
 * - **One decision at a time per compound per process**: the others queue
 *   here, in memory, holding no connection. Across processes the database
 *   lock still orders them, with at most one waiter per process.
 * - **A breaker**: when a decision gave up waiting for the lock (something
 *   holds it far longer than a decision), the compound's decisions are
 *   skipped for a moment instead of each waiting out its own timeout. Skipped
 *   tickets stay in the queue; the sweep takes them.
 */
@Injectable()
export class DispatchLimiter {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly busyUntil = new Map<string, number>();

  /** Null when the compound is in backoff: the caller skips its decision. */
  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T | null> {
    const previous = this.tails.get(tenantId) ?? Promise.resolve();
    const mine = previous.then(
      () => this.guarded(tenantId, fn),
      () => this.guarded(tenantId, fn),
    );
    this.tails.set(tenantId, mine);
    try {
      return await mine;
    } finally {
      if (this.tails.get(tenantId) === mine) this.tails.delete(tenantId);
    }
  }

  /** The decision timed out on the lock: back off. */
  markBusy(tenantId: string, now = Date.now()): void {
    this.busyUntil.set(tenantId, now + BUSY_BACKOFF_MS);
  }

  isBusy(tenantId: string, now = Date.now()): boolean {
    const until = this.busyUntil.get(tenantId);
    if (until === undefined) return false;
    if (until <= now) {
      this.busyUntil.delete(tenantId);
      return false;
    }
    return true;
  }

  private async guarded<T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    if (this.isBusy(tenantId)) return null;
    return fn();
  }
}
