import { createHmac, timingSafeEqual } from 'node:crypto';
import { instantOf } from '../../core/common/validation/instant';
import { DriverError } from '../vendors/vendor-call';
import type { AlarmDriver, AlarmEvent } from './alarm-driver';

/**
 * The fake vendor's signing key. Public, in the code, on purpose: a fake
 * driver is refused in production (env.schema.ts), so it never signs
 * anything a real compound trusts (ADR 0068).
 */
export const FAKE_ALARM_SIGNING_KEY = 'jiwar-fake-alarm-vendor-not-a-secret';
export const FAKE_ALARM_SIGNATURE_HEADER = 'x-fake-alarm-signature';

const KINDS = ['fall', 'no_motion', 'panic', 'cancelled'] as const;

/** The signature the fake vendor puts on a body (tests sign with it). */
export const signFakeAlarm = (body: unknown) =>
  createHmac('sha256', FAKE_ALARM_SIGNING_KEY)
    .update(JSON.stringify(body))
    .digest('hex');

/**
 * The fake guard-down vendor (ADR 0068), for development and tests. A call
 * is its own when the header holds the HMAC of the JSON body under the key
 * above; the body is `{ eventId, deviceRef, kind, at }`.
 */
export class FakeAlarmDriver implements AlarmDriver {
  parseEvent(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): AlarmEvent {
    const given = headers[FAKE_ALARM_SIGNATURE_HEADER];
    if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given))
      throw new DriverError('rejected');
    const want = Buffer.from(signFakeAlarm(body), 'hex');
    if (!timingSafeEqual(Buffer.from(given, 'hex'), want))
      throw new DriverError('rejected');
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new DriverError('rejected');
    const b = body as Record<string, unknown>;
    const at = instantOf(b.at);
    if (
      typeof b.eventId !== 'string' ||
      typeof b.deviceRef !== 'string' ||
      !KINDS.includes(b.kind as AlarmEvent['kind']) ||
      !at
    )
      throw new DriverError('rejected');
    return {
      eventId: b.eventId,
      deviceRef: b.deviceRef,
      kind: b.kind as AlarmEvent['kind'],
      at,
    };
  }
}
