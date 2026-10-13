/** What a transport is asked to send: one message to one device. */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** String values only (an FCM rule). */
  data: Record<string, string>;
  /** A critical kind: delivered at high priority. */
  critical: boolean;
  /**
   * The notification's id. Sent as the collapse id, so a phone that somehow
   * got the same notification twice shows it once.
   */
  collapseId: string;
}

/**
 * What became of one send. A transport answers; it does not throw.
 *
 * - `token`: the provider says this token is dead (unregistered, another
 *   sender's, malformed): the device is deleted.
 * - `payload`: the provider refused the message itself. Retrying cannot
 *   help and the token is not at fault: the delivery is given up, the
 *   token kept.
 * - `transient`: the provider did not take the message (quota, an outage,
 *   no connection, no credentials): it is tried again later.
 * - `unknown`: the request left and no answer came back. It may have
 *   arrived, so it is never sent again (at most once, ADR 0041).
 */
export type PushResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'token' | 'payload' | 'transient' | 'unknown';
      /** A provider or network code: loggable, never content. */
      code: string;
      /** The provider asked to wait at least this long (`Retry-After`). */
      retryAfterMs?: number;
    };

export interface PushTransport {
  send(message: PushMessage): Promise<PushResult>;
}

/**
 * The transport, or null when push is not configured (FCM_PROJECT_ID and
 * FCM_SERVICE_ACCOUNT unset): then nothing is queued and nothing is sent.
 * Tests put a fake here; nothing in a test opens a socket.
 */
export const PUSH_TRANSPORT = Symbol('PUSH_TRANSPORT');
