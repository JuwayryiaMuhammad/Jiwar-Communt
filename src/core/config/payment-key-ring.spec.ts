import { randomBytes } from 'node:crypto';
import {
  decodePaymentKey,
  parsePreviousPaymentKeys,
  paymentKeyRing,
} from './payment-key-ring';

describe('payment key ring (ADR 0046)', () => {
  it('decodes standard and URL-safe base64 of exactly 32 bytes', () => {
    const raw = randomBytes(32);
    expect(decodePaymentKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(decodePaymentKey(raw.toString('base64url'))?.equals(raw)).toBe(true);
    expect(decodePaymentKey(randomBytes(31).toString('base64'))).toBeNull();
    expect(decodePaymentKey(randomBytes(48).toString('base64'))).toBeNull();
    expect(decodePaymentKey('not base64 at all!')).toBeNull();
    expect(decodePaymentKey('a'.repeat(32))).toBeNull();
  });

  it('parses retired keys and refuses bad entries without quoting a key', () => {
    const a = randomBytes(32).toString('base64');
    const b = randomBytes(32).toString('base64');
    const ok = parsePreviousPaymentKeys(`1:${a}, 2:${b}`);
    expect(Array.isArray(ok) && ok.map((k) => k.version)).toEqual([1, 2]);
    for (const bad of [`x:${a}`, `0:${a}`, `1:short`, `1:${a},1:${b}`, a]) {
      const out = parsePreviousPaymentKeys(bad);
      expect(out).toHaveProperty('invalid');
      expect(JSON.stringify(out)).not.toContain(a.slice(0, 10));
    }
  });

  it('builds the ring: the current key by its version, plus the retired ones', () => {
    const cur = randomBytes(32).toString('base64');
    const old = randomBytes(32).toString('base64');
    const ring = paymentKeyRing({
      PAYMENT_CREDENTIALS_KEY: cur,
      PAYMENT_CREDENTIALS_KEY_VERSION: 3,
      PAYMENT_CREDENTIALS_PREVIOUS_KEYS: `2:${old}`,
    });
    expect(ring.current?.version).toBe(3);
    expect([...ring.byVersion.keys()].sort()).toEqual([2, 3]);
    const none = paymentKeyRing({ PAYMENT_CREDENTIALS_KEY_VERSION: 1 });
    expect(none.current).toBeNull();
    expect(none.byVersion.size).toBe(0);
  });
});
