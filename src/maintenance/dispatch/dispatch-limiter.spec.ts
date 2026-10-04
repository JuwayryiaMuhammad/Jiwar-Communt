import { DispatchBusyError } from './dispatch-busy';
import { BUSY_BACKOFF_MS, DispatchLimiter } from './dispatch-limiter';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('DispatchLimiter', () => {
  it('runs one decision at a time per compound, in order', async () => {
    const limiter = new DispatchLimiter();
    const log: string[] = [];
    let running = 0;
    let overlap = 0;
    const job = (name: string) => async () => {
      running++;
      overlap = Math.max(overlap, running);
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      running--;
      return name;
    };
    const results = await Promise.all([
      limiter.run('t1', job('a')),
      limiter.run('t1', job('b')),
      limiter.run('t1', job('c')),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(overlap).toBe(1);
    expect(log).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      'start c',
      'end c',
    ]);
  });

  it('lets different compounds run side by side', async () => {
    const limiter = new DispatchLimiter();
    let running = 0;
    let overlap = 0;
    const job = async () => {
      running++;
      overlap = Math.max(overlap, running);
      await tick();
      running--;
    };
    await Promise.all([limiter.run('t1', job), limiter.run('t2', job)]);
    expect(overlap).toBe(2);
  });

  it('a failing decision does not stop the ones behind it', async () => {
    const limiter = new DispatchLimiter();
    const first = limiter.run('t1', () => Promise.reject(new Error('boom')));
    const second = limiter.run('t1', () => Promise.resolve('ok'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
  });

  it('skips a compound in backoff, and only until the backoff ends', async () => {
    const limiter = new DispatchLimiter();
    const t0 = 1_000_000;
    limiter.markBusy('t1', t0);
    expect(limiter.isBusy('t1', t0 + BUSY_BACKOFF_MS - 1)).toBe(true);
    expect(limiter.isBusy('t2', t0)).toBe(false);
    expect(limiter.isBusy('t1', t0 + BUSY_BACKOFF_MS)).toBe(false);
    const job = jest.fn(() => Promise.resolve('x'));
    limiter.markBusy('t1');
    await expect(limiter.run('t1', job)).resolves.toBeNull();
    expect(job).not.toHaveBeenCalled();
  });

  it('a decision that gave up on the lock puts the compound in backoff before the next waiter starts', async () => {
    const limiter = new DispatchLimiter();
    const second = jest.fn(() => Promise.resolve('x'));
    const first = limiter.run('t1', () =>
      Promise.reject(new DispatchBusyError()),
    );
    const queued = limiter.run('t1', second);
    await expect(first).rejects.toBeInstanceOf(DispatchBusyError);
    await expect(queued).resolves.toBeNull();
    expect(second).not.toHaveBeenCalled();
  });
});
