import type { MessageKey } from '../messages/ar.ts';

/** API error codes (and this app's own) that have their own text. */
const ERRORS = [
  'NETWORK',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'FORBIDDEN',
  'VISITOR_PASS_NOT_FOUND',
  'ACTION_TOKEN_INVALID',
  'STEP_UP_CODE_INVALID',
  'STORAGE_UNAVAILABLE',
  'OTP_INVALID',
  // A partner's desk (ADR 0060).
  'PARTNER_DESK_NOT_FOUND',
  'PARTNER_REQUEST_NOT_FOUND',
  'PARTNER_REQUEST_INVALID_TRANSITION',
  'PARTNER_REQUEST_WINDOW_PASSED',
  'PARTNER_REQUEST_TOO_EARLY',
  'PARTNER_REQUEST_CONSENT_WITHDRAWN',
  // A registrant's documents (ADR 0062).
  'REGISTRATION_DOCUMENT_LIMIT',
  'REGISTRATION_DOCUMENT_NOT_FOUND',
  'REGISTRATION_DOCUMENTS_REQUIRED',
  'REGISTRATION_NOT_AWAITING_CORRECTION',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'FILE_CONTENT_MISMATCH',
  'FILE_UPLOAD_MISSING',
  'FILE_UPLOAD_EXPIRED',
] as const;

const FIELDS = [
  'FIELD_REQUIRED',
  'FIELD_NOT_ALLOWED',
  'INVALID_TYPE',
  'INVALID_VALUE',
  'INVALID_FORMAT',
  'INVALID_LENGTH',
  'INVALID_PHONE',
  'INVALID_EMAIL',
  'INVALID_NATIONAL_ID',
  'INVALID_PASSPORT_NUMBER',
  'INVALID_NATIONALITY',
  'BIRTH_DATE_REQUIRED',
  'INVALID_BIRTH_DATE',
  'INVALID_NUMBER',
  'PARTNER_WINDOW_TOO_SOON',
  'PARTNER_WINDOW_TOO_FAR',
  'PARTNER_WINDOW_LENGTH',
] as const;

/** The API never returns display text: a code is translated here. */
export function errorKey(code: string | null | undefined): MessageKey {
  return (ERRORS as readonly string[]).includes(code ?? '')
    ? (`error.${code as (typeof ERRORS)[number]}` satisfies MessageKey)
    : 'error.generic';
}

export function fieldErrorKey(code: string | null | undefined): MessageKey {
  return (FIELDS as readonly string[]).includes(code ?? '')
    ? (`field.${code as (typeof FIELDS)[number]}` satisfies MessageKey)
    : 'field.generic';
}

export type FieldError = { field: string; code: string; params?: Record<string, unknown> };

/** `fields` of a VALIDATION_FAILED answer, tolerating anything else. */
export function fieldErrors(fields: unknown): FieldError[] {
  if (!Array.isArray(fields)) return [];
  const out: FieldError[] = [];
  for (const item of fields as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const { field, code, params } = item as Record<string, unknown>;
    if (typeof field !== 'string' || typeof code !== 'string') continue;
    out.push({
      field,
      code,
      ...(params && typeof params === 'object' ? { params: params as Record<string, unknown> } : {}),
    });
  }
  return out;
}

/** Fill `{name}` placeholders; a missing value leaves the text readable. */
export function format(text: string, params?: Record<string, unknown>): string {
  return text.replace(/\{([a-z]+)\}/g, (_, name: string) => {
    const value = params?.[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  });
}
