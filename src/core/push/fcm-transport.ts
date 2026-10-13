import { createSign } from 'node:crypto';
import type { FcmServiceAccount } from '../config/fcm-service-account';
import type { PushMessage, PushResult, PushTransport } from './push-transport';

export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Google's maximum for a service-account assertion. */
const ASSERTION_TTL_SECONDS = 3600;
/** The access token is renewed this long before it runs out. */
const TOKEN_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Node's codes for "the connection was never made": the request did not
 * leave, so the message was certainly not sent and may be tried again.
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

type Fetch = typeof fetch;

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: {
      '@type'?: string;
      errorCode?: string;
      fieldViolations?: { field?: string }[];
    }[];
  };
}

/**
 * Firebase Cloud Messaging, HTTP v1 (ADR 0041): one request per message,
 * for Android and iOS alike. The service account signs a short JWT (RS256,
 * node:crypto) and trades it for an OAuth access token, kept until just
 * before it expires; no SDK. Nothing here logs: the caller logs the code.
 */
export class FcmTransport implements PushTransport {
  private accessToken: { value: string; expiresAt: number } | null = null;
  /** One exchange in flight, shared by a burst of sends. */
  private pending: Promise<string> | null = null;

  constructor(
    private readonly projectId: string,
    private readonly account: FcmServiceAccount,
    private readonly fetchFn: Fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async send(message: PushMessage): Promise<PushResult> {
    let bearer: string;
    try {
      bearer = await this.token();
    } catch (error) {
      // Nothing was sent: the message never left.
      return { ok: false, kind: 'transient', code: authCode(error) };
    }
    let response: Response;
    try {
      response = await this.fetchFn(
        `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ message: fcmMessage(message) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      const code = networkCode(error);
      return {
        ok: false,
        kind: NOT_CONNECTED.has(code) ? 'transient' : 'unknown',
        code,
      };
    }
    if (response.ok) return { ok: true };
    if (response.status === 401) this.accessToken = null;
    return classify(
      response.status,
      await readError(response),
      retryAfterMs(response.headers.get('retry-after')),
    );
  }

  private token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.clock())
      return Promise.resolve(this.accessToken.value);
    this.pending ??= this.exchange().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const response = await this.fetchFn(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.assertion(),
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new AuthError(`OAUTH_${response.status}`);
    const body = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== 'string')
      throw new AuthError('OAUTH_NO_TOKEN');
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 0;
    this.accessToken = {
      value: body.access_token,
      expiresAt: this.clock() + seconds * 1000 - TOKEN_SKEW_MS,
    };
    return body.access_token;
  }

  /** The signed JWT Google exchanges for an access token. */
  assertion(): string {
    const iat = Math.floor(this.clock() / 1000);
    const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: this.account.clientEmail,
        scope: FCM_SCOPE,
        aud: OAUTH_TOKEN_URL,
        iat,
        exp: iat + ASSERTION_TTL_SECONDS,
      }),
    );
    const signature = createSign('RSA-SHA256')
      .update(`${head}.${claims}`)
      .sign(this.account.privateKey, 'base64url');
    return `${head}.${claims}.${signature}`;
  }
}

class AuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** The FCM wire shape of a message. */
export function fcmMessage(message: PushMessage) {
  return {
    token: message.token,
    notification: { title: message.title, body: message.body },
    data: message.data,
    android: {
      priority: message.critical ? 'HIGH' : 'NORMAL',
      notification: { tag: message.collapseId },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-collapse-id': message.collapseId,
      },
      payload: { aps: { sound: 'default' } },
    },
  };
}

/**
 * What an FCM error means for the token (ADR 0041). UNREGISTERED and
 * SENDER_ID_MISMATCH are about the token. INVALID_ARGUMENT is about the
 * token only when FCM names it: the same code answers a malformed message,
 * and a bug in a payload must not delete every device.
 */
export function classify(
  status: number,
  body: FcmErrorBody,
  retryAfter?: number,
): PushResult {
  const details = body.error?.details ?? [];
  const code =
    details.find((d) => typeof d.errorCode === 'string')?.errorCode ??
    body.error?.status ??
    `HTTP_${status}`;
  if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH')
    return { ok: false, kind: 'token', code };
  if (code === 'INVALID_ARGUMENT') {
    const namesToken =
      details.some((d) =>
        d.fieldViolations?.some((v) => v.field === 'message.token'),
      ) || /registration token/i.test(body.error?.message ?? '');
    return namesToken
      ? { ok: false, kind: 'token', code }
      : { ok: false, kind: 'payload', code: 'INVALID_PAYLOAD' };
  }
  // An answer that is not a success: FCM did not take the message.
  if (status === 401 || status === 403 || status === 429 || status >= 500)
    return {
      ok: false,
      kind: 'transient',
      code,
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    };
  return { ok: false, kind: 'payload', code };
}

async function readError(response: Response): Promise<FcmErrorBody> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    return {};
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function authCode(error: unknown): string {
  return error instanceof AuthError
    ? error.code
    : `OAUTH_${networkCode(error)}`;
}

/** A code with no content: the network's, or the error's class. */
function networkCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  const e = error as { code?: unknown; name?: unknown; cause?: unknown };
  const cause = e.cause as { code?: unknown } | undefined;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof e.code === 'string') return e.code;
  return typeof e.name === 'string' ? e.name : 'UNKNOWN';
}
