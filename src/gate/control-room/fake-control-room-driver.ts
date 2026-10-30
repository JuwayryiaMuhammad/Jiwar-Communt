import { DriverError, type DriverErrorKind } from '../vendors/vendor-call';
import type {
  ControlRoomDelivery,
  ControlRoomDriver,
} from './control-room-driver';

/**
 * The fake control-room vendor (ADR 0068), for development and tests;
 * refused in production. It keeps what it received, by event id, and how
 * many times; `failNext(kind)` fails the next delivery.
 */
export class FakeControlRoomDriver implements ControlRoomDriver {
  readonly received = new Map<
    string,
    { tenantId: string; event: ControlRoomDelivery; times: number }
  >();
  private failures: DriverErrorKind[] = [];

  deliver(
    input: { tenantId: string; event: ControlRoomDelivery },
    signal: AbortSignal,
  ): Promise<void> {
    const kind = this.failures.shift();
    if (kind) return Promise.reject(new DriverError(kind));
    if (signal.aborted) return Promise.reject(new DriverError('timeout'));
    const had = this.received.get(input.event.eventId);
    this.received.set(input.event.eventId, {
      ...input,
      times: (had?.times ?? 0) + 1,
    });
    return Promise.resolve();
  }

  failNext(kind: DriverErrorKind = 'unavailable'): void {
    this.failures.push(kind);
  }
}
