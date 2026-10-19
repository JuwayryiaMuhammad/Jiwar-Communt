/**
 * Postgres refused a lock: `NOWAIT` found it held, or `lock_timeout`
 * passed (SQLSTATE 55P03, lock_not_available).
 */
export function isLockNotAvailable(error: unknown): boolean {
  const e = error as {
    code?: string;
    meta?: { code?: string };
    message?: string;
  };
  return (
    e?.meta?.code === '55P03' ||
    e?.code === '55P03' ||
    /lock timeout|could not obtain lock|55P03/i.test(e?.message ?? '')
  );
}
