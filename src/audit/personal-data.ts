import type { AuditAction } from './actions';
import { AUDIT_ACTIONS } from './actions';

// ============================================================================
// Personal data never enters the audit tables by value (ADR 0014)
// ============================================================================

/** Always sensitive, whatever the action. Compared case- and `_`-insensitively. */
const SENSITIVE_FIELDS = [
  'fullName',
  'firstName',
  'lastName',
  'nationalId',
  'phone',
  'email',
];
// Broad on purpose: any future `newPassword`, `temporaryPassword`,
// `passwordResetCode`, `apiToken`… is withheld by default.
const SENSITIVE_PATTERN = /password|hash|token|secret/i;

/**
 * Named exceptions to SENSITIVE_PATTERN only — fields that match it but hold
 * nothing secret. Each addition is a reviewed decision; the list never
 * overrides SENSITIVE_FIELDS or an action's own `sensitive` list.
 */
export const NOT_SENSITIVE: readonly string[] = [
  'mustChangePassword', // a boolean flag, useful in the trail
];

const norm = (key: string) => key.replace(/_/g, '').toLowerCase();
const SENSITIVE_NORMALIZED = new Set(SENSITIVE_FIELDS.map(norm));

export function isSensitiveField(key: string, action?: AuditAction): boolean {
  const extra: readonly string[] =
    (action &&
      (AUDIT_ACTIONS[action] as { sensitive?: readonly string[] }).sensitive) ||
    [];
  if (SENSITIVE_NORMALIZED.has(norm(key))) return true;
  if (extra.some((f) => norm(f) === norm(key))) return true;
  if (NOT_SENSITIVE.some((f) => norm(f) === norm(key))) return false;
  return SENSITIVE_PATTERN.test(key);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Heuristics for values that look like personal data. */
const PERSONAL_VALUE_PATTERNS: [string, RegExp][] = [
  ['email', /[^\s@]+@[^\s@]+\.[^\s@]+/],
  ['phone', /\+\d{8,15}(?!\d)/],
  ['phone', /(?<!\d)01[0125]\d{8}(?!\d)/],
  ['national id', /(?<!\d)\d{14}(?!\d)/],
];

export function looksPersonal(value: string): string | null {
  if (UUID.test(value)) return null; // ids are fine, and often digit-heavy
  for (const [kind, pattern] of PERSONAL_VALUE_PATTERNS) {
    if (pattern.test(value)) return kind;
  }
  return null;
}

/** A sensitive key in audit metadata: always a developer error. */
export class SensitiveKeyError extends Error {
  constructor(readonly path: string) {
    super(
      `Sensitive key "${path}" in audit metadata; record it as { changed: true } in changes instead`,
    );
    this.name = 'SensitiveKeyError';
  }
}

/** A value that looks like personal data, in test mode (see sanitize). */
export class PersonalValueError extends Error {
  constructor(readonly paths: string[]) {
    super(`Values that look like personal data at: ${paths.join(', ')}`);
    this.name = 'PersonalValueError';
  }
}

export interface Sanitized<T> {
  value: T;
  /** Paths whose values were replaced by "[redacted]". */
  redacted: string[];
}

export const REDACTED = '[redacted]';

/**
 * Checks what is about to be stored:
 * - `metadata` keys that are sensitive → SensitiveKeyError (always);
 * - string values that look personal → replaced by "[redacted]" and
 *   reported, or PersonalValueError when `strict` (tests). A heuristic must
 *   never block real work in production.
 */
export function sanitize<T>(
  input: T,
  opts: { checkKeys: boolean; strict: boolean; root: string },
): Sanitized<T> {
  const redacted: string[] = [];

  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (looksPersonal(value)) {
        redacted.push(path);
        return REDACTED;
      }
      return value;
    }
    if (Array.isArray(value))
      return value.map((v, i) => walk(v, `${path}.${i}`));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          const here = `${path}.${k}`;
          if (opts.checkKeys && isSensitiveField(k))
            throw new SensitiveKeyError(here);
          return [k, walk(v, here)];
        }),
      );
    }
    return value;
  };

  const value = walk(input, opts.root) as T;
  if (opts.strict && redacted.length) throw new PersonalValueError(redacted);
  return { value, redacted };
}
