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
 */
@Injectable()
export class SweepRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SweepRunner.name);
  private readonly tasks = new Map<string, SweepTask>();
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
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

  register(name: string, task: SweepTask): void {
    if (this.tasks.has(name))
      throw new Error(`Sweep task ${name} is registered twice`);
    this.tasks.set(name, task);
  }

  onApplicationBootstrap(): void {
    if (this.enabled) this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  /** Runs every task once; returns what each did (for tests and logs). */
  async runAll(now: Date = new Date()): Promise<Record<string, number>> {
    const done: Record<string, number> = {};
    for (const [name, task] of this.tasks) {
      try {
        done[name] = await task(now);
      } catch (error) {
        this.logger.error(
          `sweep task ${name} failed (${error instanceof Error ? error.name : 'Error'})`,
        );
        done[name] = -1;
      }
    }
    return done;
  }

  /** Runs one task by name (tests). */
  run(name: string, now: Date = new Date()): Promise<number> {
    const task = this.tasks.get(name);
    if (!task) throw new Error(`Unknown sweep task ${name}`);
    return task(now);
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
    const tenants = await this.globalDb.tenant.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let done = 0;
    for (const t of tenants) {
      try {
        done += await this.cls.run({ ifNested: 'inherit' }, () => {
          this.cls.set('auditActor', { type: 'system', id: null });
          return this.tenantTx.runInTenantUnsafe(t.id, (tx) => fn(tx, t.id));
        });
      } catch (error) {
        this.logger.error(
          `sweep failed in a compound (${error instanceof Error ? error.name : 'Error'})`,
        );
      }
    }
    return done;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = this.runAll().finally(() => {
        this.current = null;
        this.schedule();
      });
    }, this.intervalMs);
  }
}
