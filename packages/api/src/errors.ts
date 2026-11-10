import { translator, type Locale } from '@jiwar/i18n/core';
import errorsAr from './messages/ar/errors.ts';
import fieldsAr from './messages/ar/fields.ts';
import genericAr from './messages/ar/generic.ts';
import errorsEn from './messages/en/errors.ts';
import fieldsEn from './messages/en/fields.ts';
import genericEn from './messages/en/generic.ts';

/** The backend's error envelope (AllExceptionsFilter, ADR 0013). */
export interface FieldErrorBody {
  field: string;
  code: string;
  params?: Record<string, unknown>;
}

export interface ApiErrorBody {
  statusCode?: number;
  code?: string;
  message?: string;
  params?: Record<string, unknown>;
  fields?: FieldErrorBody[];
  requestId?: string;
}

export class ApiError extends Error {
  // Plain fields, not parameter properties: node's type stripping runs this file in tests.
  readonly status: number;
  readonly code: string;
  readonly fields: FieldErrorBody[];
  readonly params: Record<string, unknown>;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    fields: FieldErrorBody[] = [],
    params: Record<string, unknown> = {},
    requestId?: string,
  ) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.params = params;
    this.requestId = requestId;
  }

  static from(status: number, body: ApiErrorBody | undefined): ApiError {
    const code =
      typeof body?.code === 'string'
        ? body.code
        : status === 0
          ? 'NETWORK_ERROR'
          : 'REQUEST_FAILED';
    return new ApiError(
      status,
      code,
      Array.isArray(body?.fields) ? body.fields : [],
      body?.params && typeof body.params === 'object' ? body.params : {},
      body?.requestId,
    );
  }

  fieldError(field: string): FieldErrorBody | undefined {
    return this.fields.find((f) => f.field === field);
  }
}

/*
 * The text for a code is in the catalogs (`messages/{en,ar}/errors.ts` and
 * `fields.ts`). The API never sends display text; `message` is for
 * developers. An unknown code falls back to a generic sentence, never to the
 * raw `message`.
 */
const errors = { en: errorsEn, ar: errorsAr } as const;
const fields = { en: fieldsEn, ar: fieldsAr } as const;

export function errorText(error: unknown, locale: Locale): string {
  const t = translator(locale, genericEn, genericAr);
  if (error instanceof ApiError) {
    return (errors[locale] as Record<string, string>)[error.code] ?? t('requestFailed');
  }
  return t('somethingWrong');
}

export function fieldText(code: string, params: Record<string, unknown> | undefined, locale: Locale): string {
  const t = translator(locale, genericEn, genericAr);
  const range = (params ?? {}) as { min?: number; max?: number };
  const has = (v: unknown): v is number => typeof v === 'number';
  if (code === 'INVALID_LENGTH' && params) {
    if (has(range.min) && has(range.max)) return t('length.between', { min: range.min, max: range.max });
    if (has(range.max)) return t('length.max', { max: range.max });
    if (has(range.min)) return t('length.min', { min: range.min });
  }
  if (code === 'INVALID_NUMBER' && params) {
    if (has(range.min) && has(range.max)) return t('number.between', { min: range.min, max: range.max });
    if (has(range.max)) return t('number.max', { max: range.max });
    if (has(range.min)) return t('number.min', { min: range.min });
  }
  return (fields[locale] as Record<string, string>)[code] ?? t('invalidValue');
}

/** The first field error for `field` (or one of its sub-fields), if any. */
export function fieldErrorBody(error: unknown, field: string): FieldErrorBody | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.fields.find((x) => x.field === field || x.field.startsWith(field + '.'));
}
