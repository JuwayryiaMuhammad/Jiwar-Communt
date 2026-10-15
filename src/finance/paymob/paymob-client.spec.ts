import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import { PaymobClient, PaymobGatewayError } from './paymob-client';
import {
  PaymobTransportError,
  type PaymobRequest,
  type PaymobResponse,
  type PaymobTransport,
} from './paymob-transport';

const creds = {
  secretKey: 'egy_sk_test_secret',
  publicKey: 'egy_pk_test_public',
  hmacSecret: 'hmac',
  cardIntegrationId: 111,
  walletIntegrationId: 222,
};

function client(answer: (req: PaymobRequest) => PaymobResponse) {
  const sent: PaymobRequest[] = [];
  const transport: PaymobTransport = {
    send: (req) => {
      sent.push(req);
      return Promise.resolve(answer(req));
    },
  };
  const env: Partial<Env> = {
    PAYMOB_BASE_URL: 'https://accept.paymob.test',
    PAYMOB_REQUEST_TIMEOUT_MS: 5000,
  };
  const config = {
    get: (k: keyof Env) => env[k],
  } as unknown as ConfigService<Env, true>;
  return { c: new PaymobClient(config, transport), sent };
}

const request = {
  amountCents: 250000,
  specialReference: 'jw-session',
  items: [
    { name: 'INV-000001', amountCents: 100000 },
    { name: 'INV-000002', amountCents: 150000 },
  ],
  notificationUrl: 'https://api.test/api/v1/public/payments/paymob/t',
  redirectionUrl: 'https://app.test/paid',
  expirationSeconds: 1800,
};

describe('PaymobClient (ADR 0046)', () => {
  describe('createIntention', () => {
    it('sends the amount, both methods, the items, placeholders only, and our URLs', async () => {
      const { c, sent } = client(() => ({
        status: 201,
        body: {
          id: 'pi_test_1',
          client_secret: 'cs_1',
          intention_order_id: 987,
        },
      }));
      const out = await c.createIntention(creds, request);
      expect(out).toEqual({
        intentionId: 'pi_test_1',
        clientSecret: 'cs_1',
        orderId: '987',
      });
      const [req] = sent;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('https://accept.paymob.test/v1/intention/');
      expect(req.headers.Authorization).toBe('Token egy_sk_test_secret');
      expect(req.timeoutMs).toBe(5000);
      const body = req.body as Record<string, unknown>;
      expect(body).toMatchObject({
        amount: 250000,
        currency: 'EGP',
        payment_methods: [111, 222],
        special_reference: 'jw-session',
        notification_url: request.notificationUrl,
        redirection_url: request.redirectionUrl,
        expiration: 1800,
      });
      expect(body.items).toEqual([
        {
          name: 'INV-000001',
          amount: 100000,
          description: 'INV-000001',
          quantity: 1,
        },
        {
          name: 'INV-000002',
          amount: 150000,
          description: 'INV-000002',
          quantity: 1,
        },
      ]);
      const billing = body.billing_data as Record<string, string>;
      expect(
        Object.values(billing).every(
          (v) => v === 'NA' || v === 'EG' || v === 'na@example.com',
        ),
      ).toBe(true);
    });

    it('card only when the compound has no wallet integration', async () => {
      const { c, sent } = client(() => ({
        status: 201,
        body: { id: 7, client_secret: 'cs', payment_keys: [{ order_id: 55 }] },
      }));
      const out = await c.createIntention(
        { ...creds, walletIntegrationId: null },
        request,
      );
      expect(out.orderId).toBe('55');
      expect(
        (sent[0].body as { payment_methods: number[] }).payment_methods,
      ).toEqual([111]);
    });

    it.each([
      [401, 'rejected'],
      [403, 'rejected'],
      [400, 'rejected'],
      [422, 'rejected'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ])('HTTP %s → %s', async (status, kind) => {
      const { c } = client(() => ({ status, body: { detail: 'x' } }));
      await expect(c.createIntention(creds, request)).rejects.toMatchObject({
        kind,
      });
    });

    it('a body without an id or a client secret is a bad response', async () => {
      const { c } = client(() => ({ status: 201, body: { id: 'pi' } }));
      await expect(c.createIntention(creds, request)).rejects.toMatchObject({
        kind: 'bad_response',
      });
      const html = client(() => ({ status: 200, body: '<html>' }));
      await expect(
        html.c.createIntention(creds, request),
      ).rejects.toBeInstanceOf(PaymobGatewayError);
    });

    it('a timeout or a network failure says so', async () => {
      for (const kind of ['timeout', 'network'] as const) {
        const { c } = client(() => {
          throw new PaymobTransportError(kind);
        });
        await expect(c.createIntention(creds, request)).rejects.toMatchObject({
          kind: kind === 'timeout' ? 'timeout' : 'unavailable',
        });
      }
    });
  });

  it('builds the hosted checkout URL from the public key and the client secret', () => {
    const { c } = client(() => ({ status: 200, body: {} }));
    expect(c.checkoutUrl('egy_pk_test_public', 'cs_1')).toBe(
      'https://accept.paymob.test/unifiedcheckout/?publicKey=egy_pk_test_public&clientSecret=cs_1',
    );
  });

  describe('verifyIntention', () => {
    const expected = {
      amountCents: 250000,
      specialReference: 'jw-session',
      orderId: '987',
    };
    const paid = {
      special_reference: 'jw-session',
      intention_detail: { amount: 250000, currency: 'EGP' },
      status: 'intended',
      paid: true,
      order_id: 987,
      transactions: [],
    };
    const check = (status: number, body: unknown) =>
      client(() => ({ status, body })).c.verifyIntention(
        creds,
        'cs_1',
        expected,
      );

    it('reads the intention by public key and client secret', async () => {
      const { c, sent } = client(() => ({ status: 200, body: paid }));
      expect(await c.verifyIntention(creds, 'cs_1', expected)).toEqual({
        outcome: 'verified',
      });
      expect(sent[0]).toMatchObject({
        method: 'GET',
        url: 'https://accept.paymob.test/v1/intention/element/egy_pk_test_public/cs_1/',
      });
      expect(sent[0].headers.Authorization).toBeUndefined();
    });

    it.each([
      [
        'another amount',
        { ...paid, intention_detail: { amount: 250001, currency: 'EGP' } },
        'amount',
      ],
      [
        'another currency',
        { ...paid, intention_detail: { amount: 250000, currency: 'USD' } },
        'currency',
      ],
      [
        'another reference',
        { ...paid, special_reference: 'jw-other' },
        'reference',
      ],
      ['another order', { ...paid, order_id: 988 }, 'order'],
    ])('%s is a contradiction', async (_, body, reason) => {
      expect(await check(200, body)).toEqual({
        outcome: 'contradicted',
        reason,
      });
    });

    it('403 and 404 are contradictions: Paymob has no such intention', async () => {
      expect((await check(403, {})).outcome).toBe('contradicted');
      expect((await check(404, '<h1>Not Found</h1>')).outcome).toBe(
        'contradicted',
      );
    });

    it('not paid yet, an outage, an unreadable body or no order id are "unavailable", never verified', async () => {
      expect(await check(200, { ...paid, paid: false })).toEqual({
        outcome: 'unavailable',
        reason: 'not_paid_yet',
      });
      expect((await check(500, {})).outcome).toBe('unavailable');
      expect((await check(200, '<html>')).outcome).toBe('unavailable');
      const noOrder: Record<string, unknown> = { ...paid };
      delete noOrder.order_id;
      expect((await check(200, noOrder)).outcome).toBe('unavailable');
      const down = client(() => {
        throw new PaymobTransportError('timeout');
      });
      expect(
        (await down.c.verifyIntention(creds, 'cs_1', expected)).outcome,
      ).toBe('unavailable');
    });
  });
});
