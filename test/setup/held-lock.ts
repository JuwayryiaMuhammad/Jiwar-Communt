import { Client } from 'pg';
import { required } from './test-env';

/** How long each act may take to queue behind the held lock. */
const REACH_MS = 5_000;

type Settled<T> = { value: T } | { error: unknown };

/**
 * Writes queued in a chosen order behind one held row lock. `lock` is a
 * statement that takes the lock (e.g. `SELECT … FOR UPDATE`), run on a
 * superuser connection inside a transaction left open; each act is sent
 * only once every act before it waits, directly or through another
 * waiter, on that lock. Then the lock is released and every act's answer
 * returned in order. Two writes that take the same rows in opposite
 * orders deadlock here, one of them a 500.
 */
export async function queuedBehind<T>(
  lock: { sql: string; params: unknown[] },
  acts: (() => PromiseLike<T>)[],
): Promise<T[]> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  const sent: Promise<Settled<T>>[] = [];
  try {
    await db.query('BEGIN');
    await db.query(lock.sql, lock.params);
    const { rows } = await db.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    for (const act of acts) {
      // Sent now (a supertest request starts on `then`), settled either way.
      sent.push(
        Promise.resolve(act()).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      );
      const deadline = Date.now() + REACH_MS;
      for (;;) {
        const waiting = await db.query<{ n: number }>(
          `WITH RECURSIVE w(pid) AS (
             SELECT pid FROM pg_stat_activity
              WHERE $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a
               JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid))
           )
           SELECT count(*)::int AS n FROM w`,
          [rows[0].pid],
        );
        if (waiting.rows[0].n >= sent.length) break;
        if (Date.now() > deadline) {
          await db.query('ROLLBACK');
          await Promise.all(sent);
          throw new Error(`Write ${sent.length} never queued behind the lock`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await db.query('COMMIT');
    const done = await Promise.all(sent);
    return done.map((d) => {
      if ('error' in d) throw d.error;
      return d.value;
    });
  } finally {
    await db.end();
  }
}
