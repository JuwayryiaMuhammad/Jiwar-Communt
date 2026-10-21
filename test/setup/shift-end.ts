import { Client } from 'pg';
import { required } from './test-env';

/** How long a write may take to reach the shift's lock. */
const REACH_MS = 5_000;

/**
 * A guard write while their shift ends (ADR 0056's lock order). The end is
 * an UPDATE of the shift, held uncommitted on a superuser connection while
 * `act` is sent; once `act` waits behind it, the end commits and `act`'s
 * answer is returned. A write that read the shift without locking it would
 * never wait (it sees the shift still open) and would act after the end:
 * that throws here, and the end is rolled back.
 */
export async function whileShiftEnds<T>(
  shiftId: string,
  act: () => PromiseLike<T>,
): Promise<T> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      `UPDATE guard_shifts SET ended_at = now(), end_reason = 'race'
        WHERE id = $1 AND ended_at IS NULL`,
      [shiftId],
    );
    const { rows } = await db.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    // Sent now (a supertest request starts on `then`), settled either way.
    const sent = Promise.resolve(act()).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const deadline = Date.now() + REACH_MS;
    for (;;) {
      const waiting = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [rows[0].pid],
      );
      if (waiting.rows[0].n > 0) break;
      if (Date.now() > deadline) {
        await db.query('ROLLBACK');
        await sent;
        throw new Error('The write never waited for the shift’s end');
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await db.query('COMMIT');
    const done = await sent;
    if ('error' in done) throw done.error;
    return done.value;
  } finally {
    await db.end();
  }
}
