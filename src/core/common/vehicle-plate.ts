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

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/**
 * What two plates are compared by (ADR 0045): a tidied plate without its
 * spaces, its Arabic-Indic digits as Western ones. "ق ب ط ١٢٣٤" and
 * "قبط1234" are one plate. The database computes the same key in a
 * generated `plate_key` column:
 *   translate(replace(plate, ' ', ''), '٠١٢٣٤٥٦٧٨٩', '0123456789')
 * and a test feeds both the same plates. Arabic letter variants are not
 * folded: plates use a closed set of letters.
 */
export function plateKey(plate: string): string {
  let key = '';
  for (const ch of plate.replace(/ /g, '')) {
    const digit = ARABIC_INDIC.indexOf(ch);
    key += digit >= 0 ? String(digit) : ch;
  }
  return key;
}
