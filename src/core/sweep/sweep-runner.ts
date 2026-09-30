import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

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

  constructor(config: ConfigService<Env, true>) {
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
