import { TwilioSmsSender } from './twilio-sms.sender';

const credentials = {
  accountSid: `AC${'a'.repeat(32)}`,
  apiKeySid: `SK${'b'.repeat(32)}`,
  apiKeySecret: 'secret-of-the-api-key',
  messagingServiceSid: `MG${'c'.repeat(32)}`,
};
const PHONE = '+201012345678';
const message = {
  to: PHONE,
  body: 'Jiwar: your login code is 123456.',
  validitySeconds: 300,
};

type Call = [string, RequestInit & { signal: AbortSignal }];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sender(fetchFn: jest.Mock, timeoutMs = 5000) {
  return new TwilioSmsSender(credentials, timeoutMs, fetchFn, 0);
}

describe('TwilioSmsSender', () => {
  it("posts the Messages resource of the account, form-encoded, with the API key's basic auth", async () => {
    const fetchFn = jest.fn().mockResolvedValue(json(201, { sid: 'SM1' }));
    await expect(sender(fetchFn).send(message)).resolves.toEqual({ ok: true });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as Call;
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages.json`,
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${credentials.apiKeySid}:${credentials.apiKeySecret}`).toString('base64')}`,
    );
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      To: PHONE,
      MessagingServiceSid: credentials.messagingServiceSid,
      Body: message.body,
      ValidityPeriod: '300',
    });
    // No From: the sender belongs to the Messaging Service, not to the code.
    expect(form.has('From')).toBe(false);
  });

  it('gives the request a timeout', async () => {
    const fetchFn = jest.fn().mockResolvedValue(json(201, {}));
    await sender(fetchFn, 1500).send(message);
    const [, init] = fetchFn.mock.calls[0] as Call;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it('a timeout is unknown and is never sent again', async () => {
    const timeout = Object.assign(new Error('The operation timed out'), {
      name: 'TimeoutError',
    });
    const fetchFn = jest.fn().mockRejectedValue(timeout);
    await expect(sender(fetchFn).send(message)).resolves.toEqual({
      ok: false,
      kind: 'unknown',
      code: 'TIMEOUT',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a connection that was never made is tried once more, and then it is unavailable', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const fetchFn = jest.fn().mockRejectedValue(refused);
    await expect(sender(fetchFn).send(message)).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      code: 'ECONNREFUSED',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a retry that works is a success, and never more than one retry', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    });
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(json(201, {}));
    await expect(sender(fetchFn).send(message)).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])('%s is tried once more', async (status) => {
    const fetchFn = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json(status, { code: 20429, message: 'slow down' })),
      );
    await expect(sender(fetchFn).send(message)).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      code: 'TWILIO_20429',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a 500 may have taken the message: not retried', async () => {
    const fetchFn = jest.fn().mockResolvedValue(json(500, {}));
    await expect(sender(fetchFn).send(message)).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      code: 'HTTP_500',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([21211, 21614, 21610])(
    'Twilio error %s is about the number',
    async (code) => {
      const fetchFn = jest
        .fn()
        .mockResolvedValue(json(400, { code, message: 'bad number' }));
      await expect(sender(fetchFn).send(message)).resolves.toEqual({
        ok: false,
        kind: 'number',
        code: `TWILIO_${code}`,
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [401, 20003],
    [400, 21408],
    [400, 21608],
  ])('%s / Twilio error %s is about the account', async (status, code) => {
    const fetchFn = jest.fn().mockResolvedValue(json(status, { code }));
    await expect(sender(fetchFn).send(message)).resolves.toMatchObject({
      ok: false,
      kind: 'rejected',
      code: `TWILIO_${code}`,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('never returns what Twilio said, and never the number or the text', async () => {
    // Twilio echoes the number in its message and in its "more_info".
    const echo = json(400, {
      code: 21211,
      message: `The 'To' number ${PHONE} is not a valid phone number.`,
      more_info: `https://www.twilio.com/docs/errors/21211?to=${PHONE}`,
    });
    const result = await sender(jest.fn().mockResolvedValue(echo)).send(
      message,
    );
    const shown = JSON.stringify(result);
    expect(shown).not.toContain(PHONE);
    expect(shown).not.toContain('201012345678');
    expect(shown).not.toContain(message.body);
    expect(shown).not.toContain('valid phone number');
  });

  it('an error body that is not JSON still answers with the status', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(
        new Response('<html>bad gateway</html>', { status: 502 }),
      );
    await expect(sender(fetchFn).send(message)).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      code: 'HTTP_502',
    });
  });

  it('leaves the validity out when the message has none', async () => {
    const fetchFn = jest.fn().mockResolvedValue(json(201, {}));
    await sender(fetchFn).send({ to: PHONE, body: 'x' });
    const [, init] = fetchFn.mock.calls[0] as Call;
    expect(new URLSearchParams(init.body as string).has('ValidityPeriod')).toBe(
      false,
    );
  });
});
