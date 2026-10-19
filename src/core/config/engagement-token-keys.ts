// ============================================================================
// The worker card's derivation keys (ADR 0057)
// ============================================================================
//
// A worker card's token is derived (ADR 0057), as a visitor pass's is
// (ADR 0043), so the gate's offline bundle can carry what the device needs
// to recognise the card while the server stores only HMACs. Each
// engagement records the version of the key its card was derived with: a
// new key derives new and reissued cards only, and the old ones stay in the
// ring, so a rotation never kills a printed card.
//
// ENGAGEMENT_TOKEN_KEYS is `ver:key[,ver:key]`; ENGAGEMENT_TOKEN_KEY_VERSION
// names the one new cards use.

export const ENGAGEMENT_KEY_MIN = 32;
export const ENGAGEMENT_KEY_VERSION_MAX = 32767;

/**
 * The ring as written in the environment, or why it is wrong (never
 * quoting a key).
 */
export function parseEngagementTokenKeys(
  value: string,
): Map<number, string> | { invalid: string } {
  const ring = new Map<number, string>();
  for (const part of value.split(',')) {
    const match = /^\s*(\d{1,5}):(\S+)\s*$/.exec(part);
    const version = match ? Number(match[1]) : NaN;
    if (!match || version < 1 || version > ENGAGEMENT_KEY_VERSION_MAX)
      return { invalid: 'each entry must be <version>:<key>' };
    if (match[2].length < ENGAGEMENT_KEY_MIN)
      return {
        invalid: `the key of version ${version} must be at least ${ENGAGEMENT_KEY_MIN} characters`,
      };
    if (ring.has(version))
      return { invalid: `version ${version} appears twice` };
    if ([...ring.values()].includes(match[2]))
      return { invalid: `the key of version ${version} repeats another` };
    ring.set(version, match[2]);
  }
  return ring;
}

export interface EngagementTokenKeyRing {
  /** Derives new and reissued cards. */
  current: { version: number; key: string };
  /** Every key a card may have been derived with, by version. */
  byVersion: ReadonlyMap<number, string>;
}

/** The ring from an already validated environment. */
export function engagementTokenKeyRing(env: {
  ENGAGEMENT_TOKEN_KEYS: string;
  ENGAGEMENT_TOKEN_KEY_VERSION: number;
}): EngagementTokenKeyRing {
  const ring = parseEngagementTokenKeys(env.ENGAGEMENT_TOKEN_KEYS);
  if (!(ring instanceof Map)) throw new Error(ring.invalid);
  const key = ring.get(env.ENGAGEMENT_TOKEN_KEY_VERSION);
  if (!key) throw new Error('ENGAGEMENT_TOKEN_KEY_VERSION is not in the ring');
  return {
    current: { version: env.ENGAGEMENT_TOKEN_KEY_VERSION, key },
    byVersion: ring,
  };
}
