import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import {
  PAYMOB_TRANSPORT,
  PaymobTransportError,
  type PaymobTransport,
} from './paymob-transport';

/** One compound's Paymob credentials, opened from the vault. */
export interface PaymobCredentials {
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  cardIntegrationId: number;
  walletIntegrationId: number | null;
}

export interface IntentionRequest {
  amountCents: number;
  /** Our reference, unique per Paymob account: `jw-<session id>`. */
  specialReference: string;
  /** One per invoice: its number and its amount in cents. */
  items: { name: string; amountCents: number }[];
  notificationUrl: string;
  redirectionUrl: string;
  expirationSeconds: number;
}

export interface Intention {
  intentionId: string;
  clientSecret: string;
  /** Paymob's order id, which every signed callback carries as `order.id`. */
  orderId: string | null;
}

/** Why Paymob could not open a checkout; no detail reaches the client. */
export class PaymobGatewayError extends Error {
  constructor(
    readonly kind: 'timeout' | 'unavailable' | 'rejected' | 'bad_response',
    readonly status?: number,
  ) {
    super(`Paymob ${kind}${status ? ` (${status})` : ''}`);
  }
}

export type IntentionCheck =
  | { outcome: 'verified' }
  /** Paymob positively disagrees: retrying will not change it. */
  | { outcome: 'contradicted'; reason: string }
  /** Not known yet (lag, timeout, outage): try again later. */
  | { outcome: 'unavailable'; reason: string };

/**
 * The Paymob Intention API (ADR 0046), ported from Jiwar-Hub's client:
 * create an intention for a hosted checkout, and read an intention back to
 * verify a callback. Every call goes through the injectable transport.
 */
@Injectable()
export class PaymobClient {
  private readonly logger = new Logger(PaymobClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(PAYMOB_TRANSPORT) private readonly transport: PaymobTransport,
  ) {
    this.baseUrl = config.get('PAYMOB_BASE_URL', { infer: true });
    this.timeoutMs = config.get('PAYMOB_REQUEST_TIMEOUT_MS', { infer: true });
  }

  async createIntention(
    creds: PaymobCredentials,
    req: IntentionRequest,
  ): Promise<Intention> {
    if (!Number.isSafeInteger(req.amountCents) || req.amountCents <= 0) {
      throw new Error('amountCents must be a positive integer');
    }
    const methods = [creds.cardIntegrationId];
    if (creds.walletIntegrationId !== null) {
      methods.push(creds.walletIntegrationId);
    }
    const res = await this.call({
      method: 'POST',
      url: `${this.baseUrl}/v1/intention/`,
      headers: {
        Authorization: `Token ${creds.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        amount: req.amountCents,
        currency: 'EGP',
        payment_methods: methods,
        items: req.items.map((i) => ({
          name: i.name,
          amount: i.amountCents,
          description: i.name,
          quantity: 1,
        })),
        // Placeholders only (ADR 0046): the hosted checkout asks the payer
        // for what it needs; no name, email or phone leaves the compound.
        billing_data: PLACEHOLDER_BILLING,
        special_reference: req.specialReference,
        notification_url: req.notificationUrl,
        redirection_url: req.redirectionUrl,
        expiration: req.expirationSeconds,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new PaymobGatewayError('rejected', res.status);
    }
    if (res.status >= 500) {
      throw new PaymobGatewayError('unavailable', res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new PaymobGatewayError('rejected', res.status);
    }
    const body = asObject(res.body);
    if (!body) throw new PaymobGatewayError('bad_response', res.status);
    const id = body.id;
    const clientSecret = body.client_secret;
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      typeof clientSecret !== 'string' ||
      clientSecret.length === 0
    ) {
      throw new PaymobGatewayError('bad_response', res.status);
    }
    return {
      intentionId: String(id),
      clientSecret,
      orderId: orderIdOf(body),
    };
  }

  /** The hosted checkout's address; rebuilt on demand, never stored. */
  checkoutUrl(publicKey: string, clientSecret: string): string {
    const q = new URLSearchParams({ publicKey, clientSecret });
    return `${this.baseUrl}/unifiedcheckout/?${q.toString()}`;
  }

  /**
   * Reads the intention behind `clientSecret` and checks it against what the
   * session expects (ADR 0046). Authenticated by the secret itself, so only
   * the server that opened the checkout can ask.
   *
   * - 403/404: Paymob has no such intention → contradicted.
   * - A different amount, currency, reference or order → contradicted.
   * - `paid` not yet true → unavailable: the endpoint lags the payment, and
   *   the signed callback already claims success.
   */
  async verifyIntention(
    creds: Pick<PaymobCredentials, 'publicKey'>,
    clientSecret: string,
    expected: {
      amountCents: number;
      specialReference: string;
      orderId: string;
    },
  ): Promise<IntentionCheck> {
    let res;
    try {
      res = await this.call({
        method: 'GET',
        url: `${this.baseUrl}/v1/intention/element/${encodeURIComponent(
          creds.publicKey,
        )}/${encodeURIComponent(clientSecret)}/`,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (error instanceof PaymobGatewayError) {
        return { outcome: 'unavailable', reason: error.kind };
      }
      throw error;
    }
    if (res.status === 403 || res.status === 404) {
      return { outcome: 'contradicted', reason: `no_intention_${res.status}` };
    }
    const body = asObject(res.body);
    if (res.status !== 200 || !body) {
      return { outcome: 'unavailable', reason: `status_${res.status}` };
    }
    const detail = asObject(body.intention_detail);
    if (detail?.amount !== expected.amountCents) {
      return { outcome: 'contradicted', reason: 'amount' };
    }
    if (
      typeof detail.currency !== 'string' ||
      detail.currency.toUpperCase() !== 'EGP'
    ) {
      return { outcome: 'contradicted', reason: 'currency' };
    }
    if (body.special_reference !== expected.specialReference) {
      return { outcome: 'contradicted', reason: 'reference' };
    }
    const orderId = orderIdOf(body);
    if (orderId !== null && orderId !== expected.orderId) {
      return { outcome: 'contradicted', reason: 'order' };
    }
    if (body.paid !== true) {
      return { outcome: 'unavailable', reason: 'not_paid_yet' };
    }
    if (orderId === null) {
      return { outcome: 'unavailable', reason: 'no_order' };
    }
    return { outcome: 'verified' };
  }

  private async call(request: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }) {
    try {
      return await this.transport.send({
        ...request,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof PaymobTransportError) {
        this.logger.warn(`Paymob ${request.method} failed: ${error.kind}`);
        throw new PaymobGatewayError(
          error.kind === 'timeout' ? 'timeout' : 'unavailable',
        );
      }
      throw error;
    }
  }
}

const PLACEHOLDER_BILLING = {
  first_name: 'NA',
  last_name: 'NA',
  email: 'na@example.com',
  phone_number: 'NA',
  apartment: 'NA',
  floor: 'NA',
  street: 'NA',
  building: 'NA',
  city: 'NA',
  state: 'NA',
  country: 'EG',
  postal_code: 'NA',
} as const;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Paymob's order id for an intention: `intention_order_id` on creation, or
 * `order_id` (top level or on the first payment key) as the element read
 * returns it. A string, so ids beyond 2^53 compare exactly.
 */
function orderIdOf(body: Record<string, unknown>): string | null {
  const keys = Array.isArray(body.payment_keys) ? body.payment_keys : [];
  const first = asObject(keys[0]);
  for (const v of [body.intention_order_id, body.order_id, first?.order_id]) {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) {
      return String(v);
    }
    if (typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v)) return v;
  }
  return null;
}
