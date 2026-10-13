import { appError, ErrorCode, FieldErrorCode, type FieldError } from './errors';

/** One text the staff write in both languages, e.g. `title` → titleEn, titleAr. */
export interface TextField {
  name: string;
  max: number;
}

type LocalizedInput = Record<string, string | null | undefined>;
export type Localized = Record<string, string | null>;

const LANGUAGES = ['En', 'Ar'] as const;

export const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/**
 * What the staff wrote, per language (ADR 0040): English, Arabic or both.
 * A language is whole or absent (a title without its text is
 * FIELD_REQUIRED on the missing one), and at least one is there. Nothing
 * is translated: a reader gets the language that was written.
 *
 * `base` is what the content says now, for an edit: an absent field keeps
 * it, null clears it.
 */
export function localized(
  given: object,
  fields: readonly TextField[],
  base?: Localized,
  prefix = '',
): Localized {
  const input = given as LocalizedInput;
  const out: Localized = {};
  const errors: FieldError[] = [];
  for (const language of LANGUAGES) {
    for (const field of fields) {
      const key = `${field.name}${language}`;
      const given = input[key];
      const text =
        given === undefined ? (base?.[key] ?? null) : given?.trim() || null;
      if (text !== null && text.length > field.max)
        errors.push({
          field: prefix + key,
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: field.max },
        });
      out[key] = text;
    }
    const keys = fields.map((f) => `${f.name}${language}`);
    if (keys.some((k) => out[k] !== null))
      for (const k of keys)
        if (out[k] === null)
          errors.push({
            field: prefix + k,
            code: FieldErrorCode.FIELD_REQUIRED,
          });
  }
  if (Object.values(out).every((v) => v === null))
    errors.push({
      field: `${prefix}${fields[0].name}En`,
      code: FieldErrorCode.FIELD_REQUIRED,
    });
  if (errors.length) throw invalid(errors);
  return out;
}

/** Whether an edit names any of the texts at all. */
export function namesText(
  given: object,
  fields: readonly TextField[],
): boolean {
  const input = given as LocalizedInput;
  return LANGUAGES.some((language) =>
    fields.some((f) => input[`${f.name}${language}`] !== undefined),
  );
}

/** Whether two sets of texts say the same. */
export function sameText(a: Localized, b: Localized): boolean {
  return Object.keys({ ...a, ...b }).every(
    (k) => (a[k] ?? null) === (b[k] ?? null),
  );
}
