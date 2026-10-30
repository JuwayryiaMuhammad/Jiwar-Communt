import { DriverError } from '../vendors/vendor-call';

/** What a guard-down wearable reported (ADR 0068). */
export interface AlarmEvent {
  /** The vendor's id of the event: handled once. */
  eventId: string;
  /** The vendor's id of the device. */
  deviceRef: string;
  kind: 'fall' | 'no_motion' | 'panic' | 'cancelled';
  /** When the device says it happened. */
  at: Date;
}

/**
 * The guard-down vendor (ADR 0068): its devices call the server's webhook.
 * The driver checks the call is the vendor's (its signature) and reads the
 * event; our code holds every rule — who is paired, what is raised, what a
 * cancel means. A call that is not the vendor's, or says nothing we know,
 * fails with DriverError('rejected').
 */
export interface AlarmDriver {
  parseEvent(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): AlarmEvent;
}

export const ALARM_DRIVER = Symbol('ALARM_DRIVER');

/** `off`: the webhook answers 404 before the driver is asked. */
export class OffAlarmDriver implements AlarmDriver {
  parseEvent(): AlarmEvent {
    throw new DriverError('off');
  }
}
