import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The fields Paymob signs in a transaction-processed callback, in the order
 * it concatenates them (ADR 0046). A missing field contributes the string
 * "undefined", exactly as Paymob's own reference code does; booleans become
 * "true"/"false".
 *
 * `order.merchant_order_id` (our reference) is NOT signed: the webhook binds
 * the callback to a session through the signed `order.id` instead.
 */
export const PAYMOB_HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

/** The string Paymob signs for one transaction object. */
export function paymobSignedString(obj: Record<string, unknown>): string {
  return PAYMOB_HMAC_FIELDS.map((path) => String(pick(obj, path))).join('');
}

export function paymobHmac(
  obj: Record<string, unknown>,
  hmacSecret: string,
): string {
  return createHmac('sha512', hmacSecret)
    .update(paymobSignedString(obj), 'utf8')
    .digest('hex');
}

/**
 * Compares the received hmac with ours in constant time. A value that is not
 * 128 hex characters is compared against a dummy of the right length, so a
 * wrong length costs the same time and is still false.
 */
export function paymobHmacMatches(
  obj: Record<string, unknown>,
  received: string,
  hmacSecret: string,
): boolean {
  const expected = Buffer.from(paymobHmac(obj, hmacSecret), 'hex');
  const wellFormed = /^[0-9a-fA-F]{128}$/.test(received);
  const given = wellFormed
    ? Buffer.from(received.toLowerCase(), 'hex')
    : Buffer.alloc(expected.length);
  return timingSafeEqual(expected, given) && wellFormed;
}

function pick(obj: Record<string, unknown>, path: string): unknown {
  let value: unknown = obj;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
