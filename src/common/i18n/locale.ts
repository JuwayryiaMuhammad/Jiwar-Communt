/** Supported locales (ADR 0013). Arabic is the default. */
export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ar';

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Picks a locale from an `Accept-Language` header: highest q-value first,
 * header order breaking ties, language subtag only (`en-GB` → `en`).
 * Anything unsupported or malformed falls back to Arabic.
 */
export function resolveLocale(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(',')
    .slice(0, 20)
    .map((part, index) => {
      const [tag, ...attrs] = part.trim().split(';');
      const q = attrs.map((a) => a.trim()).find((a) => a.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return {
        lang: tag.trim().toLowerCase().split('-')[0],
        weight: Number.isFinite(weight) ? weight : 0,
        index,
      };
    })
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { lang } of ranked) {
    if (isLocale(lang)) return lang;
  }
  return DEFAULT_LOCALE;
}
