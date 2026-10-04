/** The dispatch lock could not be had in time (ADR 0033). */
export class DispatchBusyError extends Error {
  constructor() {
    super('The dispatch lock is busy');
    this.name = 'DispatchBusyError';
  }
}

/** Postgres refused a lock after `lock_timeout` (SQLSTATE 55P03). */
export function isLockTimeout(error: unknown): boolean {
  const e = error as {
    code?: string;
    meta?: { code?: string };
    message?: string;
  };
  return (
    e?.meta?.code === '55P03' ||
    e?.code === '55P03' ||
    /lock timeout|55P03/i.test(e?.message ?? '')
  );
}
