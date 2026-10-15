import { randomBytes } from 'node:crypto';
import { paymobHmac } from '../../src/finance/paymob/paymob-hmac';
import type {
  PaymobRequest,
  PaymobResponse,
  PaymobTransport,
} from '../../src/finance/paymob/paymob-transport';
import { PaymobTransportError } from '../../src/finance/paymob/paymob-transport';

/** An intention as the fake Paymob keeps it. */
export interface FakeIntention {
  id: string;
  clientSecret: string;
  orderId: number;
  amountCents: number;
  specialReference: string;
  secretKey: string;
  paid: boolean;
}

/**
 * Paymob, faked (ADR 0046): every suite's harness puts it in front of the
 * Paymob client, so no test ever reaches Paymob. It opens intentions,
 * answers the intention lookup from what it holds, and builds callbacks
 * signed like Paymob's with a test HMAC secret. Scripted failures:
 * `failNextCreate` (an HTTP status, or a timeout) and `lookup` (how the
 * lookup answers: as held, Paymob down, or not paid yet).
 */
export class FakePaymob implements PaymobTransport {
  readonly requests: PaymobRequest[] = [];
  readonly intentions = new Map<string, FakeIntention>();
  failNextCreate: number | 'timeout' | null = null;
  lookup: 'held' | 'down' | 'unpaid' = 'held';
  private nextOrder = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  private nextTransaction = 400_000_000 + Math.floor(Math.random() * 1_000_000);

  send(req: PaymobRequest): Promise<PaymobResponse> {
    this.requests.push(req);
    if (req.method === 'POST' && req.url.endsWith('/v1/intention/'))
      return Promise.resolve(this.create(req));
    const element = /\/v1\/intention\/element\/([^/]+)\/([^/]+)\/$/.exec(
      req.url,
    );
    if (req.method === 'GET' && element)
      return this.element(decodeURIComponent(element[2]));
    return Promise.resolve({ status: 404, body: 'not found' });
  }

  /** The intentions opened, in order. */
  get created(): FakeIntention[] {
    return [...this.intentions.values()];
  }

  /** The intention a session opened, by its reference. */
  byReference(reference: string): FakeIntention {
    const found = this.created.find((i) => i.specialReference === reference);
    if (!found) throw new Error(`no intention for ${reference}`);
    return found;
  }

  /**
   * The transaction-processed callback for an intention, signed with
   * `hmacSecret`; `over` changes the transaction (before signing), `after`
   * after it (an unsigned change, as an attacker would make).
   */
  callback(
    intention: FakeIntention,
    hmacSecret: string,
    over: Record<string, unknown> = {},
    after: (obj: Record<string, unknown>) => void = () => undefined,
  ): { hmac: string; body: { type: string; obj: Record<string, unknown> } } {
    const obj: Record<string, unknown> = {
      id: this.nextTransaction++,
      pending: false,
      amount_cents: intention.amountCents,
      success: true,
      is_auth: false,
      is_capture: false,
      is_standalone_payment: true,
      is_voided: false,
      is_refunded: false,
      is_3d_secure: true,
      integration_id: 4_100_001,
      has_parent_transaction: false,
      order: {
        id: intention.orderId,
        merchant_order_id: intention.specialReference,
      },
      created_at: new Date().toISOString(),
      currency: 'EGP',
      source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' },
      error_occured: false,
      owner: 302852,
      ...over,
    };
    const hmac = paymobHmac(obj, hmacSecret);
    after(obj);
    return { hmac, body: { type: 'TRANSACTION', obj } };
  }

  private create(req: PaymobRequest): PaymobResponse {
    if (this.failNextCreate !== null) {
      const failure = this.failNextCreate;
      this.failNextCreate = null;
      if (failure === 'timeout') throw new PaymobTransportError('timeout');
      return { status: failure, body: { detail: 'scripted failure' } };
    }
    const body = req.body as { amount: number; special_reference: string };
    const intention: FakeIntention = {
      id: `pi_test_${randomBytes(8).toString('hex')}`,
      clientSecret: `egy_csk_test_${randomBytes(16).toString('hex')}`,
      orderId: this.nextOrder++,
      amountCents: body.amount,
      specialReference: body.special_reference,
      secretKey: req.headers.Authorization.replace(/^Token /, ''),
      paid: false,
    };
    this.intentions.set(intention.clientSecret, intention);
    return {
      status: 201,
      body: {
        id: intention.id,
        client_secret: intention.clientSecret,
        intention_order_id: intention.orderId,
        status: 'intended',
      },
    };
  }

  private element(clientSecret: string): Promise<PaymobResponse> {
    if (this.lookup === 'down')
      return Promise.reject(new PaymobTransportError('timeout'));
    const i = this.intentions.get(clientSecret);
    if (!i) return Promise.resolve({ status: 403, body: { detail: 'no' } });
    return Promise.resolve({
      status: 200,
      body: {
        id: i.id,
        special_reference: i.specialReference,
        intention_detail: { amount: i.amountCents, currency: 'EGP' },
        status: 'intended',
        paid: this.lookup === 'unpaid' ? false : i.paid,
        order_id: i.orderId,
        transactions: [],
      },
    });
  }
}
