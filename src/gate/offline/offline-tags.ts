import { createHash, createHmac, randomBytes } from 'node:crypto';

// ============================================================================
// How the gate's bundle names what it carries (ADR 0057)
// ============================================================================
//
// A bundle lets a device recognise a code, a QR, a plate or a guest without
// carrying any of them in clear, nor anything the server stores. Every tag
// is 16 bytes in base64url (22 characters).
//
// - Short or guessable values (a 6- or 8-digit code, a plate key, a guest's
//   name key) are keyed: HMAC-SHA256(salt, "<kind>:<value>"), where `salt`
//   is 32 random bytes drawn for this bundle and carried in it. The pepper
//   never leaves the server, and no tag repeats across bundles or matches a
//   stored hash. Whoever extracts a bundle can still try every code: that
//   is inherent to checking one without the server, and bounded by the
//   bundle's validity, its device's revocation and the device's storage.
// - Long random values (a token of 256 bits, a credential id, a child
//   card's stored hash) are hashed with a label and the bundle's id:
//   SHA-256("jiwar:offline:v1:<kind>:<bundleId>:<value>"). Nothing can be
//   guessed back from them.

export const TAG_BYTES = 16;
export const SALT_BYTES = 32;

export type ShortTagKind =
  'visitor-code' | 'worker-code' | 'plate' | 'guest-name';
export type LongTagKind =
  'visitor-qr' | 'worker-qr' | 'resident-credential' | 'child-card';

/** A bundle's salt: 32 random bytes. */
export const newSalt = (): Buffer => randomBytes(SALT_BYTES);

/** A short or guessable value's tag, keyed with the bundle's salt. */
export function shortTag(
  salt: Buffer,
  kind: ShortTagKind,
  value: string,
): string {
  return createHmac('sha256', salt)
    .update(`${kind}:${value}`, 'utf8')
    .digest()
    .subarray(0, TAG_BYTES)
    .toString('base64url');
}

/** A long random value's tag, labelled with the bundle's id. */
export function longTag(
  bundleId: string,
  kind: LongTagKind,
  value: string,
): string {
  return createHash('sha256')
    .update(`jiwar:offline:v1:${kind}:${bundleId}:${value}`, 'utf8')
    .digest()
    .subarray(0, TAG_BYTES)
    .toString('base64url');
}
