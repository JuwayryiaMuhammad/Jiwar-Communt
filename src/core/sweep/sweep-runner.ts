import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';

/** One sweep task: does its due work as of `now`, returns how much. */
export type SweepTask = (now: Date) => Promise<number>;

export interface SweepOptions {
  /**
   * How often this task runs, when it must run more often than the others
   * (SWEEP_INTERVAL_MS): an SLA breach is due at a minute, not at an hour.
   * Such a task runs on a timer of its own and never overlaps itself.
   */
  intervalMs?: number;
}

interface Registered {
  task: SweepTask;
  intervalMs: number | null;
}

/**
 * The one in-app sweep (Phase 2.2), for work that is due at a time rather
 * than caused by a request: a minor reaching 18, an abandoned registration
 * expiring, an erasure left overdue. Domains register tasks at startup, so
 * core never imports them (ADR 0015).
 *
 * Every task must be idempotent and safe on several app instances at once
 * (claim with `UPDATE … WHERE <not done> RETURNING`). A failing task is
 * logged by name and error class and never stops the others. Tests run
 * with SWEEP_ENABLED=false and call `runAll(now)`.
 *
 * Tasks run together every SWEEP_INTERVAL_MS, one after the other. A task
 * registered with its own `intervalMs` runs on a timer of its own instead
 * (Phase 5.3: SLA breaches and late visits, every minute); each timer waits
 * for its run to finish before it is set again, so no task overlaps itself.
 */
@Injectable()
export class SweepRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SweepRunner.name);
  private readonly tasks = new Map<string, Registered>();
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  /** One timer per chain: `''` for the shared one, else the task's name. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly cls: ClsService<AppClsStore>,
  ) {
    this.enabled = config.get('SWEEP_ENABLED', { infer: true });
    this.intervalMs = config.get('SWEEP_INTERVAL_MS', { infer: true });
  }

  register(name: string, task: SweepTask, options: SweepOptions = {}): void {
    if (this.tasks.has(name))
      throw new Error(`Sweep task ${name} is registered twice`);
    const { intervalMs } = options;
    if (
      intervalMs !== undefined &&
      !(Number.isInteger(intervalMs) && intervalMs > 0)
    )
      throw new Error(`Sweep task ${name} has an invalid interval`);
    this.tasks.set(name, { task, intervalMs: intervalMs ?? null });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.schedule('', this.intervalMs, () => this.runShared());
    for (const [name, r] of this.tasks)
      if (r.intervalMs !== null)
        this.schedule(name, r.intervalMs, () => this.runOne(name, r.task));
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running]);
  }

  /** Runs every task once; returns what each did (for tests and logs). */
  async runAll(now: Date = new Date()): Promise<Record<string, number>> {
    const done: Record<string, number> = {};
    for (const [name, r] of this.tasks)
      done[name] = await this.runOne(name, r.task, now);
    return done;
  }

  /** Runs one task by name (tests). */
  run(name: string, now: Date = new Date()): Promise<number> {
    const r = this.tasks.get(name);
    if (!r) throw new Error(`Unknown sweep task ${name}`);
    return r.task(now);
  }

  /** The interval a task runs at (tests and logs). */
  intervalOf(name: string): number {
    const r = this.tasks.get(name);
    if (!r) throw new Error(`Unknown sweep task ${name}`);
    return r.intervalMs ?? this.intervalMs;
  }

  /** The tasks on the shared interval, one after the other. */
  private async runShared(): Promise<void> {
    const now = new Date();
    for (const [name, r] of this.tasks)
      if (r.intervalMs === null) await this.runOne(name, r.task, now);
  }

  /** One task; a failure is logged by name and class, and returns -1. */
  private async runOne(
    name: string,
    task: SweepTask,
    now: Date = new Date(),
  ): Promise<number> {
    try {
      return await task(now);
    } catch (error) {
      this.logger.error(
        `sweep task ${name} failed (${error instanceof Error ? error.name : 'Error'})`,
      );
      return -1;
    }
  }

  /**
   * Runs `fn` once per compound (suspended ones too: retention and
   * expiries do not wait for a compound to be reactivated), each in its own
   * tenant transaction, as the `system` actor. A compound that fails is
   * logged and skipped, so it never holds the others back; its work stays
   * due for the next run. Returns the sum of what `fn` returned.
   *
   * The one sweep helper allowed to call runInTenantUnsafe (ESLint): tasks
   * that walk every compound use this instead of an allowance of their own.
   */
  async forEachTenant(
    fn: (tx: TenantTxClient, tenantId: string) => Promise<number>,
  ): Promise<number> {
    let done = 0;
    for (const tenantId of await this.tenantIds()) {
      try {
        done += await this.inTenant(tenantId, (tx) => fn(tx, tenantId));
      } catch (error) {
        this.logger.error(
          `sweep failed in a compound (${error instanceof Error ? error.name : 'Error'})`,
        );
      }
    }
    return done;
  }

  /**
   * Like forEachTenant for work that must not hold one transaction for a
   * whole batch (a lock the work takes would be held that long): `list` runs
   * once per compound and names the items; each item then runs in a
   * transaction of its own, so whatever it locks is held for that item alone.
   * An item that fails is logged and skipped, and so is a compound whose
   * `list` fails. Returns the sum of what `item` returned.
   */
  async forEachTenantItem<T>(
    list: (tx: TenantTxClient, tenantId: string) => Promise<T[]>,
    item: (tx: TenantTxClient, tenantId: string, one: T) => Promise<number>,
  ): Promise<number> {
    let done = 0;
    for (const tenantId of await this.tenantIds()) {
      let items: T[];
      try {
        items = await this.inTenant(tenantId, (tx) => list(tx, tenantId));
      } catch (error) {
        this.logger.error(
          `sweep failed in a compound (${error instanceof Error ? error.name : 'Error'})`,
        );
        continue;
      }
      for (const one of items) {
        try {
          done += await this.inTenant(tenantId, (tx) =>
            item(tx, tenantId, one),
          );
        } catch (error) {
          this.logger.error(
            `sweep item failed (${error instanceof Error ? error.name : 'Error'})`,
          );
        }
      }
    }
    return done;
  }

  private async tenantIds(): Promise<string[]> {
    const tenants = await this.globalDb.tenant.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return tenants.map((t) => t.id);
  }

  /** One transaction in the compound, as the `system` actor. */
  private inTenant<T>(
    tenantId: string,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    return this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      return this.tenantTx.runInTenantUnsafe(tenantId, fn);
    });
  }

  /** A chain: wait, run, and only then wait again (never overlapping). */
  private schedule(
    chain: string,
    intervalMs: number,
    fn: () => Promise<unknown>,
  ): void {
    if (this.stopping) return;
    this.timers.set(
      chain,
      setTimeout(() => {
        this.timers.delete(chain);
        const run = fn().finally(() => {
          this.running.delete(run);
          this.schedule(chain, intervalMs, fn);
        });
        this.running.add(run);
      }, intervalMs),
    );
  }
}
