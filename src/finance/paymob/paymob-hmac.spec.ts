import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PAYMOB_HMAC_FIELDS,
  paymobHmac,
  paymobHmacMatches,
  paymobSignedString,
} from './paymob-hmac';

/** A transaction object shaped like Paymob's transaction-processed callback. */
const obj = {
  id: 192036465,
  pending: false,
  amount_cents: 150000,
  success: true,
  is_auth: false,
  is_capture: false,
  is_standalone_payment: true,
  is_voided: false,
  is_refunded: false,
  is_3d_secure: true,
  integration_id: 4565432,
  has_parent_transaction: false,
  order: { id: 217503754, merchant_order_id: 'jw-x' },
  created_at: '2026-10-15T10:00:00.000000',
  currency: 'EGP',
  source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' },
  error_occured: false,
  owner: 302852,
};

describe('Paymob HMAC (ADR 0046)', () => {
  it('signs the twenty fields in Paymob’s order, written by hand', () => {
    expect(PAYMOB_HMAC_FIELDS).toHaveLength(20);
    expect(paymobSignedString(obj)).toBe(
      '1500002026-10-15T10:00:00.000000EGPfalsefalse1920364654565432truefalsefalsefalsetruefalse217503754302852false2346MasterCardcardtrue',
    );
    const expected = createHmac('sha512', 'test-secret')
      .update(paymobSignedString(obj))
      .digest('hex');
    expect(paymobHmac(obj, 'test-secret')).toBe(expected);
  });

  it('a missing field signs as "undefined", as Paymob does', () => {
    const rest: Record<string, unknown> = { ...obj };
    delete rest.owner;
    expect(paymobSignedString(rest)).toContain('217503754undefinedfalse');
  });

  it('the unsigned merchant_order_id changes nothing; any signed field does', () => {
    const mac = paymobHmac(obj, 'test-secret');
    const moved = {
      ...obj,
      order: { ...obj.order, merchant_order_id: 'jw-y' },
    };
    expect(paymobHmacMatches(moved, mac, 'test-secret')).toBe(true);
    for (const changed of [
      { ...obj, amount_cents: 150001 },
      { ...obj, success: false },
      { ...obj, order: { ...obj.order, id: 217503755 } },
      { ...obj, id: 192036466 },
    ]) {
      expect(paymobHmacMatches(changed, mac, 'test-secret')).toBe(false);
    }
  });

  it('accepts upper case hex, refuses another secret, a wrong length or junk', () => {
    const mac = paymobHmac(obj, 'test-secret');
    expect(paymobHmacMatches(obj, mac.toUpperCase(), 'test-secret')).toBe(true);
    expect(paymobHmacMatches(obj, mac, 'other-secret')).toBe(false);
    expect(paymobHmacMatches(obj, mac.slice(2), 'test-secret')).toBe(false);
    expect(paymobHmacMatches(obj, `${mac}00`, 'test-secret')).toBe(false);
    expect(paymobHmacMatches(obj, 'z'.repeat(128), 'test-secret')).toBe(false);
    expect(paymobHmacMatches(obj, '', 'test-secret')).toBe(false);
  });

  it('compares with crypto.timingSafeEqual', () => {
    const source = readFileSync(join(__dirname, 'paymob-hmac.ts'), 'utf8');
    expect(source).toContain('timingSafeEqual(expected, given)');
    expect(source).not.toMatch(/===\s*received|received\s*===/);
  });
});
