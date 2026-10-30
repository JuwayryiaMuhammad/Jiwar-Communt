import { DriverError } from '../vendors/vendor-call';

/** What the control-room vendor receives: ids and codes only. */
export interface ControlRoomDelivery {
  /** The vendor's key: a redelivery of the same event is the same event. */
  eventId: string;
  kind: string;
  severity: 'high' | 'normal';
  sourceType: string;
  sourceId: string;
  gateId: string | null;
  placeId: string | null;
  occurredAt: Date;
}

/**
 * The control-room vendor (ADR 0068): a monitoring centre's feed. It gets
 * each event at least once, keyed by its id; it never gets a name, a plate
 * or a number. Fails with DriverError.
 */
export interface ControlRoomDriver {
  deliver(
    input: { tenantId: string; event: ControlRoomDelivery },
    signal: AbortSignal,
  ): Promise<void>;
}

export const CONTROL_ROOM_DRIVER = Symbol('CONTROL_ROOM_DRIVER');

/** `off`: nothing is delivered; the sweep marks each event skipped. */
export class OffControlRoomDriver implements ControlRoomDriver {
  deliver(): Promise<void> {
    return Promise.reject(new DriverError('off'));
  }
}
