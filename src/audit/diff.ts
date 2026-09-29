import type { AuditAction } from './actions';
import { isSensitiveField } from './personal-data';

export type FieldChange = { from: unknown; to: unknown } | { changed: true };
export type Changes = Record<string, FieldChange>;

/** JSON-friendly, comparable form of a field value. */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

/**
 * `{ field: { from, to } }` for the fields that changed; sensitive fields
 * become `{ changed: true }` (ADR 0014). `before = null` is a creation.
 */
export function diffChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  action: AuditAction,
): Changes {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  const out: Changes = {};
  for (const key of keys) {
    const from = normalize(before ? before[key] : null);
    const to = normalize(after[key]);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    out[key] = isSensitiveField(key, action) ? { changed: true } : { from, to };
  }
  return out;
}
