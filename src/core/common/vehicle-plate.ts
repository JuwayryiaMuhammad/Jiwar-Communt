/**
 * A vehicle plate (ADR 0043, 0045), as Egyptian plates are written and as
 * foreign ones are: Arabic letters, Latin letters, Western or Arabic-Indic
 * digits, and spaces. Stored as typed, tidied: trimmed, runs of spaces made
 * one, Latin letters upper case. 1–12 characters after that.
 *
 * One format for every plate the compound holds: a visitor's, a resident's
 * vehicle, a fine's, a parking report's.
 */
export const PLATE_MAX = 12;
const PLATE = /^[A-Z0-9ء-غف-ي٠-٩ ]+$/;

/** The plate to store, or null when it is not one. */
export function normalizePlate(raw: string): string | null {
  const plate = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!plate || plate.length > PLATE_MAX || !PLATE.test(plate)) return null;
  return plate;
}

/**
 * The fold behind `plateKey`, character for character (ADR 0045, 0047):
 * Arabic-Indic digits as Western ones, and the Arabic letter variants a
 * keyboard gives as one letter — أ/إ/آ as ا, ى as ي, ة as ه. The
 * database's generated `plate_key` columns use these two strings in
 *   translate(replace(plate, ' ', ''), PLATE_FOLD_FROM, PLATE_FOLD_TO)
 * and a test feeds both the same plates.
 */
export const PLATE_FOLD_FROM = '٠١٢٣٤٥٦٧٨٩أإآىة';
export const PLATE_FOLD_TO = '0123456789ااايه';

/**
 * What two plates are compared by: a tidied plate without its spaces,
 * folded as above. "ق ب ط ١٢٣٤" and "قبط1234" are one plate, and so are
 * "أ ب ى 12" and "ا ب ي 12".
 */
export function plateKey(plate: string): string {
  let key = '';
  for (const ch of plate.replace(/ /g, '')) {
    const at = PLATE_FOLD_FROM.indexOf(ch);
    key += at >= 0 ? PLATE_FOLD_TO[at] : ch;
  }
  return key;
}
