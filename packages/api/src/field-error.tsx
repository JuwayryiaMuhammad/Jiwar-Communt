'use client';

import { useLocale } from '@jiwar/i18n';
import type { ReactElement } from 'react';
import { errorText, fieldErrorBody, fieldText } from './errors';

/** A field error's text, in the page's language. */
export function FieldErrorText({ code, params }: { code: string; params?: Record<string, unknown> }) {
  const { locale } = useLocale();
  return <>{fieldText(code, params, locale)}</>;
}

/**
 * The message for `field` from a VALIDATION_FAILED (or similar) error, for a
 * `Field`'s `error`: it renders in the page's language wherever it lands.
 */
export function fieldError(error: unknown, field: string): ReactElement | undefined {
  const f = fieldErrorBody(error, field);
  return f ? <FieldErrorText code={f.code} params={f.params} /> : undefined;
}

/** An error's text in the page's language, where a node goes (a dialog's `error`, a line). */
export function ErrorText({ error }: { error: unknown }) {
  const { locale } = useLocale();
  return <>{errorText(error, locale)}</>;
}

/** `errorText` in the page's language, for a toast or a state that holds a string. */
export function useErrorText(): (error: unknown) => string {
  const { locale } = useLocale();
  return (error) => errorText(error, locale);
}
