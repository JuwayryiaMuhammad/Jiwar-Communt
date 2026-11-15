/** What a sender is asked to send: one text to one number. */
export interface SmsMessage {
  /** E.164. Never logged by a sender, never put in an error. */
  to: string;
  body: string;
  /**
   * How long the text is still worth delivering: a login code that reaches
   * the phone after it expired only confuses. A provider that supports it
   * drops the message after this many seconds in its queue.
   */
  validitySeconds?: number;
}

/**
 * What became of one send. A sender answers; it does not throw (the same
 * shape as the push transport, ADR 0041).
 *
 * - `number`: the provider refused this destination (not a mobile, not a
 *   valid number, the holder opted out). Sending again cannot help.
 * - `rejected`: the provider refused the request itself: credentials, a
 *   region not enabled, a sender not approved, a quota. Someone must fix
 *   the account.
 * - `unavailable`: the request did not leave, or the provider answered that
 *   it could not take it now. The text was certainly not sent.
 * - `unknown`: the request left and no answer came back (a timeout). The
 *   text may have arrived, so it is never sent again.
 */
export type SmsResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'number' | 'rejected' | 'unavailable' | 'unknown';
      /** A provider or network code: loggable, never content, never a number. */
      code: string;
    };

export interface SmsSender {
  /** Which driver this is, for logs and tests. */
  readonly provider: 'twilio' | 'log';
  send(message: SmsMessage): Promise<SmsResult>;
}

/**
 * The sender, or null when SMS is off (SMS_PROVIDER=none, the default):
 * nothing goes by SMS and every code goes by email. Tests put a fake or the
 * log sender here; nothing in a test opens a socket.
 */
export const SMS_SENDER = Symbol('SMS_SENDER');
