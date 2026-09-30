/**
 * The exact set of key paths in a response body: `data[].id`,
 * `household.memberCount`… Array items are merged, so a key present on any
 * item is listed. Values never matter, only names.
 */
export function keyPaths(value: unknown): string[] {
  const out = new Set<string>();
  walk(value, '', out);
  return [...out].sort();
}

function walk(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${prefix}[]`, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      walk(v, path, out);
    }
  }
}

/** Key paths of a `{ data, nextCursor }` list, from its item's key paths. */
export function listKeys(itemKeys: string[]): string[] {
  return ['data', ...itemKeys.map((k) => `data[].${k}`), 'nextCursor'].sort();
}
