import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isToken } from '../../core/auth/access-token';

/**
 * The QR tags of the asset register (ADR 0064): `JWA1.<assetId>.<token>`
 * on an asset, `JWL1.<areaId>.<token>` on a common area. A technician
 * scans one on arrival; the server keeps only the token's hash, so the
 * register never holds what a printed tag says. Issuing a new tag replaces
 * the hash: the old print stops working at once. Apart from every other
 * prefix the apps scan (JWC1, JWK1, JWP1, JWR1).
 */
export type TagKind = 'asset' | 'area';

const PREFIX: Record<TagKind, string> = { asset: 'JWA1.', area: 'JWL1.' };
const LABEL: Record<TagKind, string> = {
  asset: 'jiwar:asset-tag:v1',
  area: 'jiwar:area-tag:v1',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TagSecret {
  /** What the tag prints, shown once. */
  code: string;
  tokenHash: string;
}

/**
 * `hex(SHA-256("<label>:<tenant>:<id>:<token>"))`. The token is 256 random
 * bits, so a plain hash is enough and no key is involved (rotating a key
 * must never kill every printed tag); the label keeps it apart from every
 * other hash in the database.
 */
export function tagTokenHash(
  kind: TagKind,
  tenantId: string,
  id: string,
  token: string,
): string {
  return createHash('sha256')
    .update(`${LABEL[kind]}:${tenantId}:${id}:${token}`)
    .digest('hex');
}

export function issueTag(
  kind: TagKind,
  tenantId: string,
  id: string,
): TagSecret {
  const token = randomBytes(32).toString('base64url');
  return {
    code: `${PREFIX[kind]}${id}.${token}`,
    tokenHash: tagTokenHash(kind, tenantId, id, token),
  };
}

/**
 * The kind, id and token of a scanned tag, or null for anything else
 * (another prefix, a malformed id or token). Surrounding spaces are
 * ignored and the id read in lower case, as the apps read it.
 */
export function parseTag(
  raw: string,
): { kind: TagKind; id: string; token: string } | null {
  const value = raw.trim();
  const kind = (Object.keys(PREFIX) as TagKind[]).find((k) =>
    value.startsWith(PREFIX[k]),
  );
  if (!kind) return null;
  const rest = value.slice(PREFIX[kind].length);
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  const id = rest.slice(0, dot).toLowerCase();
  const token = rest.slice(dot + 1);
  if (!UUID.test(id) || !isToken(token)) return null;
  return { kind, id, token };
}

/** Whether `token` is the one behind `storedHash`, in constant time. */
export function tagMatches(
  storedHash: string | null,
  kind: TagKind,
  tenantId: string,
  id: string,
  token: string,
): boolean {
  if (storedHash === null) return false;
  const a = Buffer.from(storedHash, 'utf8');
  const b = Buffer.from(tagTokenHash(kind, tenantId, id, token), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
