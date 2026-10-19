import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

// ============================================================================
// The gate bundle's signing keys (ADR 0057)
// ============================================================================
//
// The server signs every gate bundle with Ed25519, so a device can tell a
// bundle it downloaded from one changed on the phone. GATE_BUNDLE_SIGNING_KEY
// is the private key's 32-byte seed (base64url or base64), its version is
// the key id a bundle carries. A rotation moves the old key's PUBLIC half to
// GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS (`ver:key[,ver:key]`) for as long as a
// bundle it signed may live (24 h at most): no old private key is kept.

export const SIGNING_SEED_BYTES = 32;
export const SIGNING_KEY_VERSION_MAX = 32767;

/** PKCS#8 for an Ed25519 seed: the fixed prefix, then the 32 bytes. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 32 bytes from base64url or base64, or null. */
export function decodeSeed(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(
    value.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  return bytes.length === SIGNING_SEED_BYTES ? bytes : null;
}

/** The private key of a seed. */
export function signingKeyOf(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** A key's public half: the raw 32 bytes in base64url. */
export function publicKeyOf(key: KeyObject): string {
  return createPublicKey(key).export({ format: 'jwk' }).x!;
}

/** `ver:publicKey[,…]`, or why it is wrong. */
export function parsePreviousPublicKeys(
  value: string,
): Map<number, string> | { invalid: string } {
  const keys = new Map<number, string>();
  for (const part of value.split(',')) {
    const match = /^\s*(\d{1,5}):([A-Za-z0-9_-]{43})\s*$/.exec(part);
    const version = match ? Number(match[1]) : NaN;
    if (!match || version < 1 || version > SIGNING_KEY_VERSION_MAX)
      return {
        invalid: 'each entry must be <version>:<public key in base64url>',
      };
    if (keys.has(version))
      return { invalid: `version ${version} appears twice` };
    keys.set(version, match[2]);
  }
  return keys;
}

export interface BundleSigningKeys {
  current: { version: number; privateKey: KeyObject; publicKey: string };
  /** Every public key a live bundle may have been signed with, by version. */
  publicKeys: ReadonlyMap<number, string>;
}

/** The keys from an already validated environment. */
export function bundleSigningKeys(env: {
  GATE_BUNDLE_SIGNING_KEY: string;
  GATE_BUNDLE_SIGNING_KEY_VERSION: number;
  GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS?: string;
}): BundleSigningKeys {
  const seed = decodeSeed(env.GATE_BUNDLE_SIGNING_KEY);
  if (!seed) throw new Error('GATE_BUNDLE_SIGNING_KEY is not a 32-byte seed');
  const privateKey = signingKeyOf(seed);
  const publicKey = publicKeyOf(privateKey);
  const previous = env.GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS
    ? parsePreviousPublicKeys(env.GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS)
    : new Map<number, string>();
  if (!(previous instanceof Map)) throw new Error(previous.invalid);
  const version = env.GATE_BUNDLE_SIGNING_KEY_VERSION;
  return {
    current: { version, privateKey, publicKey },
    publicKeys: new Map([...previous, [version, publicKey]]),
  };
}
