import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  classify,
  FCM_SCOPE,
  FcmTransport,
  fcmMessage,
  OAUTH_TOKEN_URL,
} from './fcm-transport';
import type { PushMessage } from './push-transport';

/** A key made for this run: nothing here is a real credential. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const account = {
  clientEmail: 'push@jiwar-test.iam.gserviceaccount.com',
  privateKey,
};
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);

const message: PushMessage = {
  token: 'device-token-1',
  title: 'A parcel has arrived',
  body: 'A parcel for unit A-1 is at the gate.',
  data: { notificationId: 'n-1', kind: 'parcel.arrived' },
  critical: false,
  collapseId: 'n-1',
};

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch that never touches the network: scripted answers, recorded calls. */
function fakeFetch(answers: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('unexpected request');
    return Promise.resolve().then(next);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const oauthOk = () => json(200, { access_token: 'access-1', expires_in: 3600 });
const sendOk = () => json(200, { name: 'projects/p/messages/1' });

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('FcmTransport (ADR 0041)', () => {
  it('signs a JWT Google can verify: header, claims, expiry and signature', () => {
    const transport = new FcmTransport('p', account, fetch, () => T0);
    const [head, claims, signature, ...rest] = transport.assertion().split('.');
    expect(rest).toEqual([]);
    expect(decode(head)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const iat = Math.floor(T0 / 1000);
    expect(decode(claims)).toEqual({
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat,
      exp: iat + 3600,
    });
    const verified = createVerify('RSA-SHA256')
      .update(`${head}.${claims}`)
      .verify(publicKey, signature, 'base64url');
    expect(verified).toBe(true);
    // Signed by this key and no other.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(
      createVerify('RSA-SHA256')
        .update(`${head}.${claims}`)
        .verify(other.publicKey, signature, 'base64url'),
    ).toBe(false);
  });

  it('trades the JWT for an access token, then sends the message with it', async () => {
    const { fn, calls } = fakeFetch([oauthOk, sendOk]);
    const transport = new FcmTransport('proj-1', account, fn, () => T0);
    await expect(transport.send(message)).resolves.toEqual({ ok: true });

    expect(calls[0].url).toBe(OAUTH_TOKEN_URL);
    const form = new URLSearchParams(calls[0].init.body as string);
    expect(form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    expect(form.get('assertion')).toBe(transport.assertion());

    expect(calls[1].url).toBe(
      'https://fcm.googleapis.com/v1/projects/proj-1/messages:send',
    );
    expect(calls[1].init.headers).toMatchObject({
      authorization: 'Bearer access-1',
    });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      message: fcmMessage(message),
    });
  });

  it('the wire message carries the text, the data, the priority and the collapse id', () => {
    expect(fcmMessage({ ...message, critical: true })).toEqual({
      token: 'device-token-1',
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: { priority: 'HIGH', notification: { tag: 'n-1' } },
      apns: {
        headers: { 'apns-priority': '10', 'apns-collapse-id': 'n-1' },
        payload: { aps: { sound: 'default' } },
      },
    });
    expect(fcmMessage(message).android.priority).toBe('NORMAL');
  });

  it('keeps the access token until just before it expires, one exchange for a burst', async () => {
    let now = T0;
    const { fn, calls } = fakeFetch([
      oauthOk,
      sendOk,
      sendOk,
      sendOk,
      oauthOk,
      sendOk,
    ]);
    const transport = new FcmTransport('p', account, fn, () => now);
    await Promise.all([transport.send(message), transport.send(message)]);
    await transport.send(message);
    expect(calls.filter((c) => c.url === OAUTH_TOKEN_URL)).toHaveLength(1);
    now = T0 + 3600_000 - 30_000; // inside the last minute
    await transport.send(message);
    expect(calls.filter((c) => c.url === OAUTH_TOKEN_URL)).toHaveLength(2);
  });

  it('an exchange that fails sends nothing and is transient', async () => {
    const { fn, calls } = fakeFetch([
      () => json(400, { error: 'invalid_grant' }),
    ]);
    const transport = new FcmTransport('p', account, fn, () => T0);
    await expect(transport.send(message)).resolves.toEqual({
      ok: false,
      kind: 'transient',
      code: 'OAUTH_400',
    });
    expect(calls).toHaveLength(1);
  });

  it('a rejected access token is dropped: the next send asks for a new one', async () => {
    const { fn, calls } = fakeFetch([
      oauthOk,
      () => json(401, { error: { status: 'UNAUTHENTICATED' } }),
      oauthOk,
      sendOk,
    ]);
    const transport = new FcmTransport('p', account, fn, () => T0);
    await expect(transport.send(message)).resolves.toMatchObject({
      kind: 'transient',
      code: 'UNAUTHENTICATED',
    });
    await expect(transport.send(message)).resolves.toEqual({ ok: true });
    expect(calls.filter((c) => c.url === OAUTH_TOKEN_URL)).toHaveLength(2);
  });

  it('a connection that was never made is transient; a lost answer is unknown', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const timedOut = Object.assign(new Error('aborted'), {
      name: 'TimeoutError',
    });
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET' },
    });
    for (const [error, expected] of [
      [refused, { ok: false, kind: 'transient', code: 'ECONNREFUSED' }],
      [timedOut, { ok: false, kind: 'unknown', code: 'TimeoutError' }],
      [reset, { ok: false, kind: 'unknown', code: 'UND_ERR_SOCKET' }],
    ] as const) {
      const { fn } = fakeFetch([
        oauthOk,
        () => {
          throw error;
        },
      ]);
      const transport = new FcmTransport('p', account, fn, () => T0);
      await expect(transport.send(message)).resolves.toEqual(expected);
    }
  });

  it('never puts the token or the key in a result', async () => {
    const { fn } = fakeFetch([
      oauthOk,
      () =>
        json(404, {
          error: {
            status: 'NOT_FOUND',
            message: `Requested entity was not found: ${message.token}`,
            details: [{ errorCode: 'UNREGISTERED' }],
          },
        }),
    ]);
    const transport = new FcmTransport('p', account, fn, () => T0);
    const result = JSON.stringify(await transport.send(message));
    expect(result).not.toContain(message.token);
    expect(result).not.toContain('PRIVATE KEY');
  });
});

describe('FCM error classification (ADR 0041)', () => {
  const fcmError = (errorCode: string) => ({
    error: {
      status: errorCode,
      details: [
        {
          '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          errorCode,
        },
      ],
    },
  });

  it('UNREGISTERED and SENDER_ID_MISMATCH condemn the token', () => {
    expect(classify(404, fcmError('UNREGISTERED'))).toEqual({
      ok: false,
      kind: 'token',
      code: 'UNREGISTERED',
    });
    expect(classify(403, fcmError('SENDER_ID_MISMATCH'))).toEqual({
      ok: false,
      kind: 'token',
      code: 'SENDER_ID_MISMATCH',
    });
  });

  it('INVALID_ARGUMENT condemns the token only when FCM names it', () => {
    const byField = {
      error: {
        status: 'INVALID_ARGUMENT',
        details: [
          { errorCode: 'INVALID_ARGUMENT' },
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [{ field: 'message.token' }],
          },
        ],
      },
    };
    const byMessage = {
      error: {
        status: 'INVALID_ARGUMENT',
        message: 'The registration token is not a valid FCM registration token',
      },
    };
    for (const body of [byField, byMessage])
      expect(classify(400, body)).toEqual({
        ok: false,
        kind: 'token',
        code: 'INVALID_ARGUMENT',
      });

    const payload = {
      error: {
        status: 'INVALID_ARGUMENT',
        message: 'Invalid value at message.data',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [{ field: 'message.data[0].value' }],
          },
        ],
      },
    };
    expect(classify(400, payload)).toEqual({
      ok: false,
      kind: 'payload',
      code: 'INVALID_PAYLOAD',
    });
    expect(classify(400, { error: { status: 'INVALID_ARGUMENT' } })).toEqual({
      ok: false,
      kind: 'payload',
      code: 'INVALID_PAYLOAD',
    });
  });

  it('quota, outages and auth failures are transient, with Retry-After', () => {
    expect(classify(429, fcmError('QUOTA_EXCEEDED'), 30_000)).toEqual({
      ok: false,
      kind: 'transient',
      code: 'QUOTA_EXCEEDED',
      retryAfterMs: 30_000,
    });
    for (const [status, code] of [
      [503, 'UNAVAILABLE'],
      [500, 'INTERNAL'],
      [403, 'PERMISSION_DENIED'],
    ] as const)
      expect(classify(status, fcmError(code))).toEqual({
        ok: false,
        kind: 'transient',
        code,
      });
    // A gateway's HTML error page.
    expect(classify(502, {})).toEqual({
      ok: false,
      kind: 'transient',
      code: 'HTTP_502',
    });
  });

  it('anything else FCM refuses is given up, the token kept', () => {
    expect(classify(404, { error: { status: 'NOT_FOUND' } })).toEqual({
      ok: false,
      kind: 'payload',
      code: 'NOT_FOUND',
    });
  });
});
