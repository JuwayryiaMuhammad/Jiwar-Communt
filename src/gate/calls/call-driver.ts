import { DriverError } from '../vendors/vendor-call';

/** Who joins a room: never a name, a number or an account id. */
export interface CallParticipant {
  kind: 'guard' | 'household';
  /** Opaque to the vendor: ours, minted per call. */
  ref: string;
}

/** What the call vendor said about a room (ADR 0068). */
export interface CallVendorEvent {
  eventId: string;
  roomRef: string;
  kind: 'participant_joined' | 'participant_left' | 'room_closed';
  at: Date;
}

/**
 * The call vendor (ADR 0068): in-app voice rooms. A room is opened per
 * call; each side joins it with a short-lived token; the room is closed
 * when the call ends. No phone number is ever given to it. Its webhook's
 * calls are checked and read by the driver (`parseEvent`). Each call takes
 * an abort signal and fails with DriverError.
 */
export interface CallDriver {
  openRoom(
    input: { tenantId: string; callId: string },
    signal: AbortSignal,
  ): Promise<{ roomRef: string }>;
  joinToken(
    input: { tenantId: string; roomRef: string; participant: CallParticipant },
    signal: AbortSignal,
  ): Promise<{ token: string; expiresAt: Date }>;
  closeRoom(
    input: { tenantId: string; roomRef: string },
    signal: AbortSignal,
  ): Promise<void>;
  parseEvent(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): CallVendorEvent;
}

export const CALL_DRIVER = Symbol('CALL_DRIVER');

/** `off`: no calls (503 reason off); the webhook answers 404. */
export class OffCallDriver implements CallDriver {
  openRoom(): Promise<{ roomRef: string }> {
    return Promise.reject(new DriverError('off'));
  }
  joinToken(): Promise<{ token: string; expiresAt: Date }> {
    return Promise.reject(new DriverError('off'));
  }
  closeRoom(): Promise<void> {
    return Promise.reject(new DriverError('off'));
  }
  parseEvent(): CallVendorEvent {
    throw new DriverError('off');
  }
}
