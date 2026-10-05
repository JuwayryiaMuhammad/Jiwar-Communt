import { Client } from 'pg';
import { required } from './test-env';

export interface PoolSamples {
  /** How many times the database was asked; a dead sampler proves nothing. */
  samples: number;
  /** Most connections of the app role in use (active or in a transaction) at once. */
  maxBusy: number;
  /** Most connections waiting on the compound's dispatch advisory lock at once. */
  maxDispatchWaiters: number;
  /** Most connections waiting on any lock at once. */
  maxLockWaiters: number;
  /** What those waits were for: the lock types seen, e.g. `transactionid`, `advisory`. */
  waitedOn: string[];
}

/**
 * Watches the app's connections (role jiwar_app, this database) from a
 * connection of its own, every few milliseconds, while a test puts load on
 * the app. It reads `pg_stat_activity` and `pg_locks`, so it sees what the
 * database sees whatever the app thinks of its pool: the structural facts
 * "who waits on the dispatch lock, and how many connections are tied up",
 * where a wall-clock bound only says the machine was slow or not.
 *
 * `dispatchLockOf` is the tenant whose lock to watch: the key the engine
 * takes is hashtextextended('maintenance.dispatch:' || tenant, 0), which
 * pg_locks shows split into classid (high 32 bits) and objid (low 32 bits).
 */
export async function samplePool(
  dispatchLockOf: string,
  everyMs = 10,
): Promise<{ stop(): Promise<PoolSamples> }> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  const result: PoolSamples = {
    samples: 0,
    maxBusy: 0,
    maxDispatchWaiters: 0,
    maxLockWaiters: 0,
    waitedOn: [],
  };
  const waitedOn = new Set<string>();
  let running = true;
  const loop = (async () => {
    while (running) {
      const { rows } = await db.query<{
        busy: string;
        dispatch: string;
        locks: string;
      }>(
        `SELECT count(*) FILTER (WHERE a.state <> 'idle') AS busy,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM pg_locks l
                   WHERE l.pid = a.pid AND l.locktype = 'advisory' AND NOT l.granted
                     AND ((l.classid::bigint << 32) | l.objid::bigint)
                         = hashtextextended('maintenance.dispatch:' || $1::text, 0)
                )) AS dispatch,
                count(*) FILTER (WHERE a.wait_event_type = 'Lock') AS locks
           FROM pg_stat_activity a
          WHERE a.datname = current_database()
            AND a.usename = 'jiwar_app'
            AND a.pid <> pg_backend_pid()`,
        [dispatchLockOf],
      );
      const waits = await db.query<{ locktype: string }>(
        `SELECT DISTINCT l.locktype
           FROM pg_locks l JOIN pg_stat_activity a USING (pid)
          WHERE NOT l.granted AND a.datname = current_database()
            AND a.usename = 'jiwar_app'`,
      );
      for (const w of waits.rows) waitedOn.add(w.locktype);
      result.samples++;
      result.maxBusy = Math.max(result.maxBusy, Number(rows[0].busy));
      result.maxDispatchWaiters = Math.max(
        result.maxDispatchWaiters,
        Number(rows[0].dispatch),
      );
      result.maxLockWaiters = Math.max(
        result.maxLockWaiters,
        Number(rows[0].locks),
      );
      await new Promise((r) => setTimeout(r, everyMs));
    }
  })();
  let stopped: Promise<PoolSamples> | undefined;
  return {
    /** Idempotent, so a test can stop it in afterEach too. */
    stop: () =>
      (stopped ??= (async () => {
        running = false;
        await loop;
        await db.end();
        return { ...result, waitedOn: [...waitedOn].sort() };
      })()),
  };
}
