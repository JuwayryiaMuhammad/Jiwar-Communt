import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from 'node:crypto';

// ============================================================================
// A guard device's key and what it signs (ADR 0057)
// ============================================================================
//
// A device holds an Ed25519 key pair; the server keeps the public key only.
// Everything the device signs is prefixed by a label of its own, so a
// signature made for one purpose is nothing in another:
//
// - enrolment: `jiwar:gate-device-enroll:v1\n<tenant>\n<device>\n<publicKey>`,
//   which proves the device holds the private key it registers;
// - an envelope: `jiwar:gate-device:v1\n<payload>`, where `payload` is the
//   base64url of the JSON it carries — signed as sent, so neither side has
//   to agree on a canonical JSON.

/** The raw 32-byte public key in base64url, without padding. */
export const DEVICE_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature (64 bytes) in base64url, without padding. */
export const DEVICE_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
/** An envelope's payload: base64url, bounded before it is decoded. */
export const ENVELOPE_PAYLOAD = /^[A-Za-z0-9_-]+$/;
export const ENVELOPE_PAYLOAD_MAX = 96_000;

export const ENROL_LABEL = 'jiwar:gate-device-enroll:v1';
export const ENVELOPE_LABEL = 'jiwar:gate-device:v1';

/** What a device proves at enrolment, signed with the key it registers. */
export const enrolMessage = (
  tenantId: string,
  deviceId: string,
  publicKey: string,
): string => `${ENROL_LABEL}\n${tenantId}\n${deviceId}\n${publicKey}`;

/** What an envelope's signature covers. */
export const envelopeMessage = (payload: string): string =>
  `${ENVELOPE_LABEL}\n${payload}`;

/** The device's public key, or null when it is not a 32-byte Ed25519 point. */
export function devicePublicKey(publicKey: string): KeyObject | null {
  if (!DEVICE_PUBLIC_KEY.test(publicKey)) return null;
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

/**
 * Whether `signature` is the device's over `message`. A malformed key or
 * signature is simply not valid: the caller answers the same either way.
 */
export function signedBy(
  publicKey: string,
  message: string,
  signature: string,
): boolean {
  if (!DEVICE_SIGNATURE.test(signature)) return false;
  const key = devicePublicKey(publicKey);
  if (!key) return false;
  try {
    return verify(
      null,
      Buffer.from(message, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

/**
 * The envelope's JSON object, or null when the payload is not base64url of
 * a JSON object within the bound.
 */
export function decodePayload(payload: string): Record<string, unknown> | null {
  if (payload.length > ENVELOPE_PAYLOAD_MAX || !ENVELOPE_PAYLOAD.test(payload))
    return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * What the replay guard keeps of an envelope: the SHA-256 of its signature
 * (hex). Ed25519 is deterministic, so the same envelope sent again has the
 * same signature; a new one (a new `sentAt`) has another.
 */
export const signatureDigest = (signature: string): string =>
  createHash('sha256')
    .update(Buffer.from(signature, 'base64url'))
    .digest('hex');
