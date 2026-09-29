import type { Locale } from '../common/i18n/locale';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * The HTML shell of every email (ADR 0013): Arabic right-to-left, English
 * left-to-right. `body` must already be escaped HTML.
 */
export function emailPage(locale: Locale, body: string): string {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const align = dir === 'rtl' ? 'right' : 'left';
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"></head><body dir="${dir}" style="direction:${dir};text-align:${align};font-family:Tahoma,Arial,sans-serif;font-size:16px">${body}</body></html>`;
}

/** For any value that did not come from a template: names, reasons, units. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * U+200F RIGHT-TO-LEFT MARK at the start of each line keeps plain-text
 * clients from flipping Arabic lines that start with digits or Latin text.
 */
export function rtlText(lines: string[]): string {
  return lines.map((l) => (l ? `‏${l}` : l)).join('\n');
}
