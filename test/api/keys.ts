/**
 * The exact set of key paths in a response body: `data[].id`,
 * `household.memberCount`… Array items are merged, so a key present on any
 * item is listed. Values never matter, only names.
 */
export function keyPaths(value: unknown, opaque: string[] = []): string[] {
  const out = new Set<string>();
  walk(value, '', out, new Set(opaque));
  return [...out].sort();
}

/** Audit `changes` and `metadata` differ per action: their insides are not part of the shape. */
export const AUDIT_OPAQUE = ['changes', 'metadata'];

function walk(
  value: unknown,
  prefix: string,
  out: Set<string>,
  opaque: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${prefix}[]`, out, opaque);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      if (!opaque.has(k)) walk(v, path, out, opaque);
    }
  }
}

/** Key paths of a `{ data, nextCursor }` list, from its item's key paths. */
export function listKeys(itemKeys: string[]): string[] {
  return ['data', ...itemKeys.map((k) => `data[].${k}`), 'nextCursor'].sort();
}
