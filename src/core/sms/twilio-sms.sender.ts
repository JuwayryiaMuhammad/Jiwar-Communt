import type { SmsMessage, SmsResult, SmsSender } from './sms-sender';

export interface TwilioCredentials {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  messagingServiceSid: string;
}

type Fetch = typeof fetch;

/**
 * Node's codes for "the connection was never made": the request did not
 * leave, so the text was certainly not sent and may be tried once more.
 * Anything else that fails after the request started is `unknown`.
 */
const NOT_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Twilio error codes that are about the destination (invalid number, not a
 * mobile, unsubscribed, cannot be reached). Everything else Twilio refuses
 * is about our account.
 */
const NUMBER_CODES = new Set([
  21211, 21214, 21217, 21401, 21407, 21421, 21610, 21612, 21614,
]);

/** Pause before the single retry. */
const RETRY_DELAY_MS = 300;

type Attempt =
  | { ok: true }
  | {
      ok: false;
      kind: 'number' | 'rejected' | 'unavailable' | 'unknown';
      code: string;
      retry: boolean;
    };

/**
 * Twilio Programmable Messaging, the REST API called with `fetch`, no SDK
 * (ADR 0095): one form-encoded POST to the account's Messages resource,
 * basic auth with an API key (a key can be revoked without touching the
 * account's master token), the sender chosen by a Messaging Service so the
 * number or the sender ID is changed in Twilio and not here.
 *
 * The request is tried at most twice, and the second time only when the
 * first provably did not reach Twilio or Twilio answered 429 or 503 (it
 * took nothing). A timeout is never retried: the text may be on its way.
 *
 * Nothing here logs, and nothing it returns holds the number, the text or
 * Twilio's message (which may echo the number): a result carries a code.
 */
export class TwilioSmsSender implements SmsSender {
  readonly provider = 'twilio' as const;

  constructor(
    private readonly credentials: TwilioCredentials,
    private readonly timeoutMs: number,
    private readonly fetchFn: Fetch = fetch,
    private readonly retryDelayMs: number = RETRY_DELAY_MS,
  ) {}

  async send(message: SmsMessage): Promise<SmsResult> {
    const first = await this.attempt(message);
    if (first.ok || !first.retry) return strip(first);
    await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    return strip(await this.attempt(message));
  }

  private async attempt(message: SmsMessage): Promise<Attempt> {
    const { accountSid, apiKeySid, apiKeySecret, messagingServiceSid } =
      this.credentials;
    const form = new URLSearchParams({
      To: message.to,
      MessagingServiceSid: messagingServiceSid,
      Body: message.body,
    });
    if (message.validitySeconds !== undefined)
      form.set('ValidityPeriod', String(message.validitySeconds));

    let response: Response;
    try {
      response = await this.fetchFn(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: form.toString(),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      const code = networkCode(error);
      return NOT_CONNECTED.has(code)
        ? { ok: false, kind: 'unavailable', code, retry: true }
        : { ok: false, kind: 'unknown', code, retry: false };
    }
    if (response.ok) return { ok: true };

    const twilioCode = await readTwilioCode(response);
    const code = twilioCode
      ? `TWILIO_${twilioCode}`
      : `HTTP_${response.status}`;
    if (response.status === 429 || response.status === 503)
      return { ok: false, kind: 'unavailable', code, retry: true };
    if (response.status >= 500)
      return { ok: false, kind: 'unavailable', code, retry: false };
    if (twilioCode !== null && NUMBER_CODES.has(twilioCode))
      return { ok: false, kind: 'number', code, retry: false };
    return { ok: false, kind: 'rejected', code, retry: false };
  }
}

function strip(attempt: Attempt): SmsResult {
  return attempt.ok
    ? { ok: true }
    : { ok: false, kind: attempt.kind, code: attempt.code };
}

/** Twilio's numeric error code from its JSON error body, or null. */
async function readTwilioCode(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === 'number' && Number.isInteger(body.code)
      ? body.code
      : null;
  } catch {
    return null;
  }
}

/** A loggable code for a failed fetch: the timeout, or Node's error code. */
function networkCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'NETWORK';
  const e = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'TIMEOUT';
  if (typeof e.code === 'string') return e.code;
  if (typeof e.cause === 'object' && e.cause !== null) {
    const cause = e.cause as { code?: unknown };
    if (typeof cause.code === 'string') return cause.code;
  }
  return 'NETWORK';
}
