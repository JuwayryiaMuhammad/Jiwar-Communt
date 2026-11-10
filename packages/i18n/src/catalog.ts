import type { Locale } from './locale.ts';
import { formatMessage, type MessageParams } from './message.ts';

/** A catalog's English messages: the keys every other language must carry. */
export type Messages = Readonly<Record<string, string>>;
/** The same keys, in another language (a missing or extra key fails to compile). */
export type Translation<M extends Messages> = { readonly [K in keyof M]: string };
export type Translate<M extends Messages> = (key: keyof M & string, params?: MessageParams) => string;

/** A translate function outside React (a helper that is handed the locale). */
export function translator<M extends Messages>(locale: Locale, en: M, ar: Translation<M>): Translate<M> {
  const messages: Translation<M> = locale === 'ar' ? ar : en;
  return (key, params) => {
    const template = messages[key] ?? en[key];
    // A key the catalog lacks shows itself, never a blank.
    return template === undefined ? key : formatMessage(locale, template, params);
  };
}
