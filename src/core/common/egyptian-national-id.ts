// ============================================================================
// Egyptian national ID (الرقم القومي)
// ============================================================================
//
// 14 digits: C YYMMDD GG SSSS K
//   C     century: 2 = 1900s, 3 = 2000s
//   YYMMDD birth date
//   GG    governorate of birth registration (88 = born abroad)
//   SSSS  sequence (the last of these is odd for males, even for females)
//   K     check digit — not validated: the algorithm is not published, and
//         guessing it would reject real IDs.
//
// The birth date is what the product needs (adult/minor rules for household
// members, delegates and domestic workers).

// prettier-ignore
const GOVERNORATES = new Set([
  '01', '02', '03', '04', // Cairo, Alexandria, Port Said, Suez
  '11', '12', '13', '14', '15', '16', '17', '18', '19', // Delta and canal
  '21', '22', '23', '24', '25', '26', '27', '28', '29', // Upper Egypt
  '31', '32', '33', '34', '35', // Frontier governorates
  '88', // Born abroad
]);

const CENTURIES: Record<string, number> = { '2': 1900, '3': 2000 };

export interface EgyptianNationalId {
  /** Normalized: 14 ASCII digits. */
  value: string;
  /** UTC midnight of the calendar birth date. */
  birthDate: Date;
  governorate: string;
}

/** Trims, drops spaces and dashes, and maps Arabic-Indic digits to ASCII. */
export function normalizeNationalId(raw: string): string {
  return raw
    .trim()
    .replace(/[\s-]/g, '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Null unless the ID is structurally valid: 14 digits, a known century, a
 * real calendar date that is not in the future, and a known governorate.
 */
export function parseEgyptianNationalId(
  raw: string,
  today: Date = egyptToday(),
): EgyptianNationalId | null {
  const value = normalizeNationalId(raw);
  if (!/^\d{14}$/.test(value)) return null;

  const century = CENTURIES[value[0]];
  if (century === undefined) return null;
  const year = century + Number(value.slice(1, 3));
  const month = Number(value.slice(3, 5));
  const day = Number(value.slice(5, 7));
  const birthDate = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 31 Feb over into March; a real date survives unchanged.
  if (
    birthDate.getUTCFullYear() !== year ||
    birthDate.getUTCMonth() !== month - 1 ||
    birthDate.getUTCDate() !== day
  ) {
    return null;
  }
  if (birthDate > today) return null;

  const governorate = value.slice(7, 9);
  if (!GOVERNORATES.has(governorate)) return null;

  return { value, birthDate, governorate };
}

/**
 * Completed years on a calendar date. The age goes up on the birthday itself;
 * someone born on 29 February turns a year older on 1 March in common years.
 */
export function ageOn(birthDate: Date, on: Date): number {
  let age = on.getUTCFullYear() - birthDate.getUTCFullYear();
  const beforeBirthday =
    on.getUTCMonth() < birthDate.getUTCMonth() ||
    (on.getUTCMonth() === birthDate.getUTCMonth() &&
      on.getUTCDate() < birthDate.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export const ADULT_AGE = 18;

export function isAdult(birthDate: Date, on: Date = egyptToday()): boolean {
  return ageOn(birthDate, on) >= ADULT_AGE;
}

/** Today's calendar date in Egypt, as UTC midnight (comparable with birth dates). */
export function egyptToday(now: Date = new Date()): Date {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
