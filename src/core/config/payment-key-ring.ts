// ============================================================================
// The payment credential key ring (ADR 0046)
// ============================================================================
//
// Each compound's Paymob credentials are stored encrypted (AES-256-GCM) under
// PAYMENT_CREDENTIALS_KEY. Every ciphertext carries the version of the key
// that sealed it, so a key can be rotated: the new key becomes current, the
// old one moves to PAYMENT_CREDENTIALS_PREVIOUS_KEYS (decrypt only) until
// `pnpm finance:reencrypt-gateways` has re-sealed everything.

export const PAYMENT_KEY_BYTES = 32;
export const PAYMENT_KEY_VERSION_MAX = 32767;

/** A key as written in the environment: standard or URL-safe base64 of 32 bytes. */
export function decodePaymentKey(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(
    value.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  return key.length === PAYMENT_KEY_BYTES ? key : null;
}

/**
 * `ver:base64[,ver:base64]`. Returns the keys, or why the value is wrong
 * (never quoting a key).
 */
export function parsePreviousPaymentKeys(
  value: string,
): { version: number; key: Buffer }[] | { invalid: string } {
  const keys: { version: number; key: Buffer }[] = [];
  for (const part of value.split(',')) {
    const match = /^\s*(\d{1,5}):(\S+)\s*$/.exec(part);
    const version = match ? Number(match[1]) : NaN;
    if (!match || version < 1 || version > PAYMENT_KEY_VERSION_MAX) {
      return { invalid: 'each entry must be <version>:<base64 key>' };
    }
    const key = decodePaymentKey(match[2]);
    if (!key) {
      return {
        invalid: `the key of version ${version} must be base64 of exactly 32 bytes`,
      };
    }
    if (keys.some((k) => k.version === version)) {
      return { invalid: `version ${version} appears twice` };
    }
    keys.push({ version, key });
  }
  return keys;
}

export interface PaymentKeyRing {
  /** Seals new ciphertexts; null when PAYMENT_CREDENTIALS_KEY is unset. */
  current: { version: number; key: Buffer } | null;
  /** Every key that may open a ciphertext, by version. */
  byVersion: ReadonlyMap<number, Buffer>;
}

/** The ring from an already validated environment. */
export function paymentKeyRing(env: {
  PAYMENT_CREDENTIALS_KEY?: string;
  PAYMENT_CREDENTIALS_KEY_VERSION: number;
  PAYMENT_CREDENTIALS_PREVIOUS_KEYS?: string;
}): PaymentKeyRing {
  const byVersion = new Map<number, Buffer>();
  const previous = env.PAYMENT_CREDENTIALS_PREVIOUS_KEYS
    ? parsePreviousPaymentKeys(env.PAYMENT_CREDENTIALS_PREVIOUS_KEYS)
    : [];
  if (Array.isArray(previous)) {
    for (const k of previous) byVersion.set(k.version, k.key);
  }
  const key = env.PAYMENT_CREDENTIALS_KEY
    ? decodePaymentKey(env.PAYMENT_CREDENTIALS_KEY)
    : null;
  if (!key) return { current: null, byVersion };
  const version = env.PAYMENT_CREDENTIALS_KEY_VERSION;
  byVersion.set(version, key);
  return { current: { version, key }, byVersion };
}
