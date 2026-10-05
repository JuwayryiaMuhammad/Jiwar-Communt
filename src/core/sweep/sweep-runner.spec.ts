import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import type { Env } from '../config/env.schema';
import type { GlobalDbService } from '../database/global-db.service';
import type { TenantTx } from '../database/tenant-tx.service';
import { SweepRunner } from './sweep-runner';

const HOUR = 3_600_000;
const MINUTE = 60_000;

function runner(enabled = true): SweepRunner {
  const values: Partial<Env> = {
    SWEEP_ENABLED: enabled,
    SWEEP_INTERVAL_MS: HOUR,
  };
  const config = {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
  return new SweepRunner(
    config,
    {} as GlobalDbService,
    {} as TenantTx,
    {} as ClsService<AppClsStore>,
  );
}

/** Lets the promise callbacks queued by a fired timer run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('SweepRunner intervals', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // A failing task is logged by design; keep the run's output clean.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runs the shared tasks every SWEEP_INTERVAL_MS and a task with its own interval on its own timer', async () => {
    const sweep = runner();
    const hourly = jest.fn(() => Promise.resolve(0));
    const minutely = jest.fn(() => Promise.resolve(0));
    sweep.register('a.hourly', hourly);
    sweep.register('a.minutely', minutely, { intervalMs: MINUTE });
    expect(sweep.intervalOf('a.hourly')).toBe(HOUR);
    expect(sweep.intervalOf('a.minutely')).toBe(MINUTE);

    sweep.onApplicationBootstrap();
    for (let i = 0; i < 60; i++) {
      jest.advanceTimersByTime(MINUTE);
      await flush();
    }
    expect(minutely).toHaveBeenCalledTimes(60);
    expect(hourly).toHaveBeenCalledTimes(1);
    await sweep.onApplicationShutdown();
  });

  it('never overlaps a task with itself: the next wait starts when the run ends', async () => {
    const sweep = runner();
    let release: () => void = () => undefined;
    let running = 0;
    let overlap = 0;
    const slow = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          running++;
          overlap = Math.max(overlap, running);
          release = () => {
            running--;
            resolve(1);
          };
        }),
    );
    sweep.register('a.slow', slow, { intervalMs: MINUTE });
    sweep.onApplicationBootstrap();
    jest.advanceTimersByTime(MINUTE);
    await flush();
    expect(slow).toHaveBeenCalledTimes(1);
    // Ten minutes pass while the run is still going: no second run.
    jest.advanceTimersByTime(10 * MINUTE);
    await flush();
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await flush();
    jest.advanceTimersByTime(MINUTE);
    await flush();
    expect(slow).toHaveBeenCalledTimes(2);
    expect(overlap).toBe(1);
    release();
    await sweep.onApplicationShutdown();
  });

  it('a failing task is logged and does not stop its timer or the others', async () => {
    const sweep = runner();
    const failing = jest.fn(() => Promise.reject(new Error('boom')));
    const fine = jest.fn(() => Promise.resolve(2));
    sweep.register('a.failing', failing, { intervalMs: MINUTE });
    sweep.register('a.fine', fine);
    expect(await sweep.runAll(new Date())).toEqual({
      'a.failing': -1,
      'a.fine': 2,
    });
    sweep.onApplicationBootstrap();
    jest.advanceTimersByTime(MINUTE);
    await flush();
    jest.advanceTimersByTime(MINUTE);
    await flush();
    expect(failing).toHaveBeenCalledTimes(3);
    await sweep.onApplicationShutdown();
  });

  it('schedules nothing when the sweep is disabled (tests call runAll)', async () => {
    const sweep = runner(false);
    const task = jest.fn(() => Promise.resolve(0));
    sweep.register('a.task', task, { intervalMs: MINUTE });
    sweep.onApplicationBootstrap();
    jest.advanceTimersByTime(2 * HOUR);
    await flush();
    expect(task).not.toHaveBeenCalled();
    await sweep.onApplicationShutdown();
  });

  it('refuses a task registered twice or with an invalid interval', () => {
    const sweep = runner();
    const task = () => Promise.resolve(0);
    sweep.register('a.task', task);
    expect(() => sweep.register('a.task', task)).toThrow(/twice/);
    expect(() => sweep.register('a.zero', task, { intervalMs: 0 })).toThrow(
      /invalid interval/,
    );
  });
});
