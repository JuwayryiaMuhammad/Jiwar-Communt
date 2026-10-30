import { ConfigService } from '@nestjs/config';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Env } from '../../core/config/env.schema';
import {
  vendorDriver,
  type VendorService,
} from '../../core/config/vendor-drivers';

/**
 * Why a driver could not do what it was asked (ADR 0068): it took too long,
 * the vendor was down, it refused the request, or answered nonsense — or
 * the driver is `off`.
 */
export type DriverErrorKind =
  'timeout' | 'unavailable' | 'rejected' | 'bad_response' | 'off';

export class DriverError extends Error {
  constructor(readonly kind: DriverErrorKind) {
    super(`vendor driver: ${kind}`);
    this.name = 'DriverError';
  }
}

/** 503: the caller may try again later, or go on by hand. */
export const vendorUnavailable = (service: VendorService, off = false) =>
  appError.serviceUnavailable(
    ErrorCode.VENDOR_UNAVAILABLE,
    off
      ? 'This service is off in this deployment'
      : 'The vendor is unavailable',
    { params: off ? { service, reason: 'off' } : { service } },
  );

/**
 * A driver call, never inside a database transaction: bounded by
 * GATE_VENDOR_TIMEOUT_MS, and any driver failure answered as 503
 * VENDOR_UNAVAILABLE {service} (`reason: 'off'` for an off driver). What
 * the vendor said is never in the error.
 */
export async function callVendor<T>(
  service: VendorService,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Rejected before the abort: a driver that settles on the abort
    // (answers late, or with nothing) never wins the race.
    timer = setTimeout(() => {
      reject(new DriverError('timeout'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), timeout]);
  } catch (e) {
    if (e instanceof DriverError)
      throw vendorUnavailable(service, e.kind === 'off');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The driver a service runs in this deployment (ADR 0068). */
export const driverChoice = (
  config: ConfigService<Env, true>,
  service: VendorService,
) =>
  vendorDriver(
    {
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
      GATE_FACE_DRIVER: config.get('GATE_FACE_DRIVER', { infer: true }),
      GATE_ID_SCAN_DRIVER: config.get('GATE_ID_SCAN_DRIVER', { infer: true }),
      GATE_CALL_DRIVER: config.get('GATE_CALL_DRIVER', { infer: true }),
      GATE_ALARM_DRIVER: config.get('GATE_ALARM_DRIVER', { infer: true }),
      CONTROL_ROOM_DRIVER: config.get('CONTROL_ROOM_DRIVER', { infer: true }),
    },
    service,
  );

/** The vendor timeout, in ms. */
export const vendorTimeout = (config: ConfigService<Env, true>) =>
  config.get('GATE_VENDOR_TIMEOUT_MS', { infer: true });
