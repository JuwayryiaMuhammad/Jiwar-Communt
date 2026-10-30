import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { instantOf } from '../../core/common/validation/instant';
import { DriverError, type DriverErrorKind } from '../vendors/vendor-call';
import type {
  CallDriver,
  CallParticipant,
  CallVendorEvent,
} from './call-driver';

/**
 * The fake call vendor's signing key: public, in the code, on purpose — a
 * fake driver is refused in production (ADR 0068).
 */
export const FAKE_CALL_SIGNING_KEY = 'jiwar-fake-call-vendor-not-a-secret';
export const FAKE_CALL_SIGNATURE_HEADER = 'x-fake-call-signature';
const KINDS = [
  'participant_joined',
  'participant_left',
  'room_closed',
] as const;

export const signFakeCallEvent = (body: unknown) =>
  createHmac('sha256', FAKE_CALL_SIGNING_KEY)
    .update(JSON.stringify(body))
    .digest('hex');

/**
 * The fake call vendor (ADR 0068), for development and tests. It keeps
 * its rooms and who was given a token for each (the participant's opaque
 * ref only); `failNext(kind)` fails the next call.
 */
export class FakeCallDriver implements CallDriver {
  readonly rooms = new Map<
    string,
    {
      tenantId: string;
      callId: string;
      open: boolean;
      joined: CallParticipant[];
    }
  >();
  private failures: DriverErrorKind[] = [];

  openRoom(
    input: { tenantId: string; callId: string },
    signal: AbortSignal,
  ): Promise<{ roomRef: string }> {
    const failed = this.fail(signal);
    if (failed) return failed;
    const roomRef = `fake-room-${input.callId}`;
    this.rooms.set(roomRef, { ...input, open: true, joined: [] });
    return Promise.resolve({ roomRef });
  }

  joinToken(
    input: { tenantId: string; roomRef: string; participant: CallParticipant },
    signal: AbortSignal,
  ): Promise<{ token: string; expiresAt: Date }> {
    const failed = this.fail(signal);
    if (failed) return failed;
    const room = this.rooms.get(input.roomRef);
    if (!room?.open) return Promise.reject(new DriverError('rejected'));
    room.joined.push(input.participant);
    return Promise.resolve({
      token: `fake-token-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  }

  closeRoom(
    input: { tenantId: string; roomRef: string },
    signal: AbortSignal,
  ): Promise<void> {
    const failed = this.fail(signal);
    if (failed) return failed;
    const room = this.rooms.get(input.roomRef);
    if (room) room.open = false;
    return Promise.resolve();
  }

  parseEvent(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): CallVendorEvent {
    const given = headers[FAKE_CALL_SIGNATURE_HEADER];
    if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given))
      throw new DriverError('rejected');
    if (
      !timingSafeEqual(
        Buffer.from(given, 'hex'),
        Buffer.from(signFakeCallEvent(body), 'hex'),
      )
    )
      throw new DriverError('rejected');
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new DriverError('rejected');
    const b = body as Record<string, unknown>;
    const at = instantOf(b.at);
    if (
      typeof b.eventId !== 'string' ||
      typeof b.roomRef !== 'string' ||
      !KINDS.includes(b.kind as CallVendorEvent['kind']) ||
      !at
    )
      throw new DriverError('rejected');
    return {
      eventId: b.eventId,
      roomRef: b.roomRef,
      kind: b.kind as CallVendorEvent['kind'],
      at,
    };
  }

  failNext(kind: DriverErrorKind = 'unavailable'): void {
    this.failures.push(kind);
  }

  private fail(signal: AbortSignal): Promise<never> | null {
    const kind = this.failures.shift();
    if (kind) return Promise.reject(new DriverError(kind));
    if (signal.aborted) return Promise.reject(new DriverError('timeout'));
    return null;
  }
}
