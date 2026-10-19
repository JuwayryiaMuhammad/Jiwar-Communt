/** Postgres refused a lock after `lock_timeout` (SQLSTATE 55P03). */
export { isLockNotAvailable as isLockTimeout } from '../../core/database/lock-errors';

/** The dispatch lock could not be had in time (ADR 0033). */
export class DispatchBusyError extends Error {
  constructor() {
    super('The dispatch lock is busy');
    this.name = 'DispatchBusyError';
  }
}
