/** An ID number as the blocklist compares it (ADR 0053): 4 to 20 of these. */
export const ID_NUMBER = /^[0-9A-Z]{4,20}$/;

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC = '۰۱۲۳۴۵۶۷۸۹';

/**
 * A full ID number (a national ID, a passport's number) as one string,
 * whoever typed it and how: spaces, dashes and dots out, Arabic-Indic
 * digits as Western ones, Latin letters upper-cased. Null when what is left
 * is not 4 to 20 letters and digits.
 */
export function normalizeIdNumber(raw: string): string | null {
  const folded = [...raw.trim()]
    .map((c) => {
      const a = ARABIC_INDIC.indexOf(c);
      if (a >= 0) return String(a);
      const e = EASTERN_ARABIC.indexOf(c);
      return e >= 0 ? String(e) : c;
    })
    .join('')
    .replace(/[\s.\-–]/g, '')
    .toUpperCase();
  return ID_NUMBER.test(folded) ? folded : null;
}
